import { describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import QueryBuilder from '@src/app/builder/QueryBuilder';

const Model =
  mongoose.models.QbSortTest ||
  mongoose.model(
    'QbSortTest',
    new mongoose.Schema({ rating: Number, receiver: String }, { timestamps: true }),
  );

const build = (query: Record<string, unknown>) => {
  const qb = new QueryBuilder(Model.find() as any, query).filter().sort();
  return {
    filter: qb.modelQuery.getFilter(),
    sort: (qb.modelQuery as any).getOptions().sort,
  };
};

describe('QueryBuilder sort/filter', () => {
  it('page=1 / limit=1 are not sort fields: default stays newest first', () => {
    expect(build({ page: '1', limit: '10', receiver: 'u1' })).toEqual({
      filter: { receiver: 'u1' },
      sort: { createdAt: -1, _id: -1 },
    });
    expect(build({ page: '1', limit: '1' }).sort).toEqual({ createdAt: -1, _id: -1 });
  });

  it('direction-only sort/order still map to createdAt', () => {
    expect(build({ sort: 'asc' }).sort).toEqual({ createdAt: 1, _id: 1 });
    expect(build({ sort: 'desc', page: '1' }).sort).toEqual({ createdAt: -1, _id: -1 });
    expect(build({ order: '-1' }).sort).toEqual({ createdAt: -1, _id: -1 });
  });

  it('a filter value of 1 is kept as a filter, not dropped as a direction', () => {
    expect(build({ rating: '1', page: '2' })).toEqual({
      filter: { rating: '1' },
      sort: { createdAt: -1, _id: -1 },
    });
  });

  it('field shorthand and explicit field sort still work', () => {
    expect(build({ rating: 'desc' })).toEqual({ filter: {}, sort: { rating: -1, _id: -1 } });
    expect(build({ sort: '-rating,createdAt' }).sort).toEqual({
      rating: -1,
      createdAt: 1,
      _id: -1,
    });
  });

  it('_id tie-breaker follows the primary direction and is not duplicated', () => {
    expect(build({ sort: 'amount' }).sort).toEqual({ amount: 1, _id: 1 });
    expect(build({ sort: '-_id' }).sort).toEqual({ _id: -1 });
  });
});
