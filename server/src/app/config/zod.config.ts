import { z } from 'zod';

/**
 * Global Zod error messages (issues 60 / 67).
 *
 * Zod 4's default messages leak schema syntax to users, e.g.
 *   Invalid option: expected one of "male"|"female"
 *   Invalid string: must match pattern /^\d{4}-\d{2}-\d{2}$/
 *   Too small: expected number to be >=1
 *
 * This hook only fills in messages for validators that did not set their own,
 * so every hand-written schema message still wins. The sentences match the
 * `validation_*` PATTERN_RULES in i18n.ts, so they are translated like any
 * other outgoing message. Lists use " / " (not ", ") because translateText()
 * splits a combined error message on ", ".
 */

/** "departureTime" / "departure_time" -> "Departure time". */
export const humanizeFieldName = (path: ReadonlyArray<PropertyKey> = []): string => {
  const key = [...path]
    .reverse()
    .find((segment) => typeof segment === 'string' && segment.length > 0) as
    | string
    | undefined;
  if (!key) return 'Value';

  const words = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_\-.]+/g, ' ')
    .trim()
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

const formatList = (values: ReadonlyArray<unknown> = []): string =>
  values.map((value) => String(value)).join(' / ');

const isList = (origin: unknown): boolean => origin === 'array' || origin === 'set';
const sizeUnit = (origin: unknown): string => (origin === 'string' ? ' characters' : isList(origin) ? ' items' : '');

export const zodCustomError = (issue: any): string | undefined => {
  const field = humanizeFieldName(issue?.path);

  switch (issue?.code) {
    case 'invalid_type':
      return issue.input === undefined || issue.input === null
        ? `${field} is required.`
        : `${field} has an invalid value.`;

    case 'invalid_value':
      return Array.isArray(issue.values) && issue.values.length
        ? `${field} must be one of: ${formatList(issue.values)}.`
        : `${field} has an invalid value.`;

    case 'invalid_format':
      if (issue.format === 'email') return 'Please enter a valid email address.';
      return `${field} has an invalid format.`;

    case 'too_small': {
      const min = issue.minimum;
      if (issue.origin === 'string' && Number(min) === 1) return `${field} is required.`;
      return issue.inclusive === false
        ? `${field} must be greater than ${min}.`
        : `${field} must ${isList(issue.origin) ? 'contain' : 'be'} at least ${min}${sizeUnit(issue.origin)}.`;
    }

    case 'too_big': {
      const max = issue.maximum;
      return issue.inclusive === false
        ? `${field} must be less than ${max}.`
        : `${field} must ${isList(issue.origin) ? 'contain' : 'be'} at most ${max}${sizeUnit(issue.origin)}.`;
    }

    case 'unrecognized_keys':
      return `Unexpected field: ${formatList(issue.keys)}.`;

    case 'invalid_union':
    case 'invalid_key':
    case 'invalid_element':
    case 'not_multiple_of':
      return `${field} has an invalid value.`;

    default:
      return undefined; // keep Zod's message (e.g. `custom` refinements set their own)
  }
};

z.config({ customError: zodCustomError });
