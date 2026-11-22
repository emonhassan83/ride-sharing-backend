/**
 * Factory for fake Mongoose *model classes*.
 *
 * Usage in a test file (the factory must be async + dynamic-import the helper because
 * `vi.mock` is hoisted above regular imports):
 *
 *   vi.mock('@src/app/modules/ride/ride.model', async () => {
 *     const { createModelMock } = await import('@tests/helpers/modelMock');
 *     return { Ride: createModelMock() };
 *   });
 *
 *   import { Ride } from '@src/app/modules/ride/ride.model';
 *   vi.mocked(Ride.findById).mockReturnValue(mockQuery(rideDoc) as any);
 *
 * Every static is a `vi.fn(impl)` with a *safe default* (finders resolve to `null`/`[]`,
 * writes resolve to an ack object). Because vitest.config.ts sets `mockReset: true`,
 * implementations given as `vi.fn(impl)` are restored before every test, while anything a
 * test configures (`mockReturnValue`, `...Once`) is wiped, so tests never leak state.
 *
 * The returned model is also a *constructor*: `new Model(doc)` yields an object with the doc's
 * fields plus `save()`, so code using `new Passenger({...}).save()` is testable.
 */
import { vi } from 'vitest';
import { mockQuery } from './mongoose';

const SINGLE_FINDERS = [
  'findOne',
  'findById',
  'findOneAndUpdate',
  'findByIdAndUpdate',
  'findOneAndDelete',
  'findByIdAndDelete',
  'findOneAndReplace',
] as const;

const WRITE_ACKS = ['updateOne', 'updateMany', 'replaceOne', 'deleteOne', 'deleteMany'] as const;

export type ModelMock = ReturnType<typeof createModelMock>;

export function createModelMock(extraStatics: string[] = []): any {
  const Model: any = vi.fn(function (this: any, doc: Record<string, any> = {}) {
    Object.assign(this, doc);
    this.save = vi.fn(async () => this);
    this.toObject = vi.fn(() => ({ ...doc }));
    this.toJSON = vi.fn(() => ({ ...doc }));
    this.populate = vi.fn(async () => this);
  });

  for (const name of SINGLE_FINDERS) Model[name] = vi.fn(() => mockQuery(null));
  for (const name of WRITE_ACKS) {
    Model[name] = vi.fn(() =>
      mockQuery({ acknowledged: true, matchedCount: 0, modifiedCount: 0, deletedCount: 0 }),
    );
  }
  Model.find = vi.fn(() => mockQuery([]));
  Model.aggregate = vi.fn(() => mockQuery([]));
  Model.distinct = vi.fn(() => mockQuery([]));
  Model.countDocuments = vi.fn(() => mockQuery(0));
  Model.estimatedDocumentCount = vi.fn(() => mockQuery(0));
  Model.exists = vi.fn(() => mockQuery(null));
  Model.insertMany = vi.fn(async (docs: unknown[]) => docs);
  Model.bulkWrite = vi.fn(async () => ({ ok: 1 }));
  // `Model.create(doc)` / `Model.create([docs], opts)` echo the input like Mongoose does.
  Model.create = vi.fn(async (docs: unknown) => docs);
  Model.populate = vi.fn(async (docs: unknown) => docs);

  for (const name of extraStatics) Model[name] = vi.fn();
  return Model;
}
