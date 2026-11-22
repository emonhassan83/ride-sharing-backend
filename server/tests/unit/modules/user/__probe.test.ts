import { describe, expect, it } from 'vitest';
import bcrypt from 'bcrypt';
import { User } from '@src/app/modules/user/user.model';

describe('probe', () => {
  it('expireAt undefined', () => {
    const u: any = new User({ name: 'x', email: 'a@b.com', role: 'admin', expireAt: undefined });
    console.log('expireAt undefined ->', u.expireAt);
    const u2: any = new User({ name: 'x', email: 'a@b.com', role: 'admin', expireAt: null });
    console.log('expireAt null ->', u2.expireAt);
  });

  it('query cast lowercase', () => {
    const q: any = User.findOne({ email: ' A@B.COM ' });
    try {
      q._castConditions();
    } catch (e) {
      console.log('cast err', e);
    }
    console.log('filter after cast', q.getFilter());
    const q2: any = User.findOne({ $or: [{ email: 'FOO@BAR.com' }, { phone: ' 123 ' }] });
    q2._castConditions();
    console.log('filter2 after cast', JSON.stringify(q2.getFilter()));
  });

  it('hooks', () => {
    const s: any = User.schema;
    console.log('hooks keys', Object.keys(s.s.hooks));
    const pres = s.s.hooks._pres;
    console.log('pres type', pres && pres.constructor && pres.constructor.name);
    const saves = pres.get('save');
    console.log('save pres', saves && saves.map((h: any) => ({ name: h.fn && h.fn.name, isAsync: h.isAsync, len: h.fn && h.fn.length, src: String(h.fn).slice(0, 80) })));
  });

  it('indexes', () => {
    console.log(JSON.stringify(User.schema.indexes()));
  });

  it('email validation', () => {
    for (const email of ['john+tag@gmail.com', 'a@b.info', 'a@b.technology', 'a@b.co.uk', 'x@y.com', 'UPPER@CASE.COM']) {
      const u: any = new User({ name: 'x', email, role: 'user' });
      const err = u.validateSync();
      console.log(email, '->', err ? Object.keys(err.errors) : 'ok', 'stored:', u.email);
    }
  });

  it('bcrypt undefined', async () => {
    await expect(bcrypt.compare('x', undefined as any)).rejects.toThrow();
    await bcrypt.compare('x', undefined as any).catch((e) => console.log('bcrypt err:', e.message));
  });

  it('password minlength', () => {
    const u: any = new User({ name: 'x', email: 'a@b.com', role: 'user', password: 'short' });
    const err = u.validateSync();
    console.log('pw err', err && Object.keys(err.errors));
  });

  it('schema paths', () => {
    console.log('passwordChangedAt', !!User.schema.path('passwordChangedAt'), 'deletedAt', !!User.schema.path('deletedAt'), 'lastPasswordChange', !!User.schema.path('lastPasswordChange'));
  });

  it('select false', () => {
    const q: any = User.findByIdAndUpdate('507f1f77bcf86cd799439011', { name: 'x' }, { returnDocument: 'after' });
    try { q._applyPaths(); } catch (e) { console.log('applyPaths err', e); }
    console.log('fields', q._fields, q.projection && q.projection());
  });

  it('update cast strict', () => {
    const q: any = User.findOneAndUpdate({ _id: '507f1f77bcf86cd799439011' }, { $set: { password: 'x', passwordChangedAt: new Date(), needsPasswordChange: false } }, { returnDocument: 'after' });
    try {
      const cast = q._castUpdate(q.getUpdate());
      console.log('cast update', JSON.stringify(cast));
    } catch (e) {
      console.log('castUpdate err', e);
    }
  });
});
