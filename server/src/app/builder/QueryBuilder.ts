import { Types, Query } from 'mongoose'

// Special / range / pagination params: never document paths, never sort fields.
const NON_FIELD_PARAMS = [
  'searchTerm',
  'sort',
  'order',
  'limit',
  'page',
  'fields',
  'minAmount',
  'maxAmount',
  'dateFrom',
  'dateTo',
  'role', // often a related-user filter, not a document field
]

// `?amount=asc` style shorthand. Words only: `1` / `-1` are ordinary filter
// values (`?page=1` used to sort by a nonexistent "page" field, and
// `?rating=1` was silently dropped as a filter).
const SHORTHAND_DIRECTIONS = ['asc', 'desc', 'ascending', 'descending']
const isShorthandDirection = (value: unknown): value is string =>
  typeof value === 'string' && SHORTHAND_DIRECTIONS.includes(value.toLowerCase())

class QueryBuilder<T> {
  public modelQuery: Query<T[], T>
  public query: Record<string, unknown>

  constructor(modelQuery: Query<T[], T>, query: Record<string, unknown>) {
    this.modelQuery = modelQuery
    this.query = query
  }

  search(searchableFields: string[]) {
    const searchTerm = this?.query?.searchTerm as string
    if (searchTerm) {
      this.modelQuery = this.modelQuery.find({
        $or: searchableFields.map((field) => ({
          [field]: { $regex: searchTerm, $options: 'i' },
        })),
      })
    }
    return this
  }

  filter() {
    const queryObj = { ...this.query }

    NON_FIELD_PARAMS.forEach((el) => delete queryObj[el])

    // Drop empty values + sort shorthands like amount=asc / createdAt=desc
    Object.keys(queryObj).forEach((key) => {
      const value = queryObj[key]
      if (
        value === '' ||
        value === undefined ||
        value === null ||
        isShorthandDirection(value)
      ) {
        delete queryObj[key]
      }
    })

    if (Object.keys(queryObj).length > 0) {
      this.modelQuery = this.modelQuery.find(queryObj as any)
    }

    return this
  }

  sort() {
    // Prefer explicit field sort: ?sort=amount / ?sort=-createdAt
    let sort = (this?.query?.sort as string)?.split(',')?.join(' ') || ''

    // Direction-only: ?sort=asc|desc or ?order=asc|desc → createdAt
    const directionOnly = (sort || String(this?.query?.order || ''))
      .trim()
      .toLowerCase()
    if (['asc', 'ascending', '1'].includes(directionOnly)) {
      sort = 'createdAt'
    } else if (['desc', 'descending', '-1'].includes(directionOnly)) {
      sort = '-createdAt'
    }

    // Field shorthand: ?amount=asc | ?createdAt=desc
    if (
      !sort ||
      ['asc', 'desc', 'ascending', 'descending', '1', '-1'].includes(
        sort.toLowerCase(),
      )
    ) {
      const parts: string[] = []
      for (const [key, value] of Object.entries(this.query || {})) {
        if (NON_FIELD_PARAMS.includes(key)) continue
        if (isShorthandDirection(value)) {
          const dir = ['desc', 'descending'].includes(value.toLowerCase())
            ? '-'
            : ''
          parts.push(`${dir}${key}`)
        }
      }
      if (parts.length) sort = parts.join(' ')
    }

    // Final normalize if still direction-only
    const finalDir = String(sort || '').toLowerCase()
    if (['asc', 'ascending', '1'].includes(finalDir)) sort = 'createdAt'
    else if (['desc', 'descending', '-1'].includes(finalDir)) sort = '-createdAt'

    // Tie-breaker: rows sharing the sort value (same createdAt) had no stable
    // order, so pages repeated or skipped rows. _id follows the primary direction.
    const sortFields = (sort || '-createdAt').split(/\s+/).filter(Boolean)
    if (!sortFields.some((f) => f.replace(/^[-+]/, '') === '_id')) {
      sortFields.push(sortFields[0].startsWith('-') ? '-_id' : '_id')
    }

    this.modelQuery = this.modelQuery.sort(sortFields.join(' '))

    return this
  }

  paginate() {
    const page = Number(this?.query?.page) || 1
    const limit = Number(this?.query?.limit) || 10
    const skip = (page - 1) * limit

    this.modelQuery = this.modelQuery.skip(skip).limit(limit)

    return this
  }

  fields() {
    const fields =
      (this?.query?.fields as string)?.split(',')?.join(' ') || '-__v'

    this.modelQuery = this.modelQuery.select(fields)
    return this
  }

  async countTotal() {
    const totalQueries = this.modelQuery.getFilter()
    const total = await this.modelQuery.model.countDocuments(totalQueries)
    const page = Number(this?.query?.page) || 1
    const limit = Number(this?.query?.limit) || 10
    const totalPage = Math.ceil(total / limit)

    return {
      page,
      limit,
      total,
      totalPage,
    }
  }
}

export default QueryBuilder
