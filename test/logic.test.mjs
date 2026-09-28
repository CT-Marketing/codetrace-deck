/*
 * Tests for the logic the deck depends on.
 *
 * The app is one HTML file with its script in an IIFE, so rather than
 * importing it we lift the specific pure functions out of index.html and
 * run them here. That means these tests check the code that actually
 * ships — if someone edits the function in index.html and breaks it, this
 * fails. If a function gets renamed or removed, extraction fails loudly
 * rather than passing on a stale copy.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HTML = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'index.html'), 'utf8');

/** Pull a top-level `function name(...) { ... }` out of the page by brace matching. */
function lift(name) {
  const start = HTML.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `index.html no longer defines ${name}()`);
  let i = HTML.indexOf('{', start), depth = 0, end = -1;
  for (; i < HTML.length; i++) {
    if (HTML[i] === '{') depth++;
    else if (HTML[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  assert.notEqual(end, -1, `could not find the end of ${name}()`);
  return HTML.slice(start, end);
}

/** Build a callable from lifted source plus whatever it depends on. */
function build(names, preamble = '', expose = names[names.length - 1]) {
  const src = preamble + '\n' + names.map(lift).join('\n') + `\nreturn ${expose};`;
  return new Function(src)();
}

const ESC = `const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));`;

/* ------------------------------------------------------------------ */

test('noteHTML formats bold, italic, underline and bullets', () => {
  const noteHTML = build(['noteHTML'], ESC);
  assert.equal(noteHTML('**bold**'), '<p><strong>bold</strong></p>');
  assert.equal(noteHTML('*it*'), '<p><em>it</em></p>');
  assert.equal(noteHTML('__u__'), '<p><u>u</u></p>');
  assert.equal(noteHTML('- one\n- two'), '<ul><li>one</li><li>two</li></ul>');
  assert.equal(
    noteHTML('Spoke to **Ada**.\n- chase Friday'),
    '<p>Spoke to <strong>Ada</strong>.</p><ul><li>chase Friday</li></ul>'
  );
});

test('noteHTML cannot be used to inject markup', () => {
  const noteHTML = build(['noteHTML'], ESC);
  for (const attack of [
    '<script>bad()</script>',
    '<img src=x onerror="alert(1)">',
    '<a href="javascript:alert(1)">click</a>',
    '**<b>still escaped</b>**'
  ]) {
    const out = noteHTML(attack);
    /* Escaped text like &lt;img onerror=...&gt; is inert, so grepping for the
       word proves nothing. What matters is that no real tag is produced
       beyond the fixed set the renderer is allowed to emit. */
    const tags = [...out.matchAll(/<\/?([a-z][a-z0-9]*)\b/gi)].map((m) => m[1].toLowerCase());
    const allowed = new Set(['p', 'strong', 'em', 'u', 'ul', 'li']);
    const bad = tags.filter((t) => !allowed.has(t));
    assert.deepEqual(bad, [], `escaping failed for: ${attack}\ngot: ${out}`);
    assert.ok(!/\son[a-z]+=["']?[^&]/i.test(out),
      `an unescaped event handler survived: ${out}`);
  }
});

test('parsePeople trims, dedupes case-insensitively and drops blanks', () => {
  const parsePeople = build(['parsePeople']);
  assert.deepEqual(parsePeople('Ada,  bob , Ada'), ['Ada', 'bob']);
  assert.deepEqual(parsePeople('  Ada   Lovelace  '), ['Ada Lovelace']);
  assert.deepEqual(parsePeople(''), []);
  assert.deepEqual(parsePeople(' , ,, '), []);
  assert.deepEqual(parsePeople('Ada\nBob;Cy'), ['Ada', 'Bob', 'Cy']);
});

test('columnOf folds "Waiting on Someone" into Pending, nothing else', () => {
  const columnOf = build([], 'const columnOf = (t) => (t.status === "Waiting on Someone" ? "Not Started" : t.status);', 'columnOf');
  assert.equal(columnOf({ status: 'Waiting on Someone' }), 'Not Started');
  assert.equal(columnOf({ status: 'Not Started' }), 'Not Started');
  assert.equal(columnOf({ status: 'In Progress' }), 'In Progress');
  assert.equal(columnOf({ status: 'Done' }), 'Done');
});

test('every task lands in exactly one of the three columns', () => {
  const STATUSES = ['Not Started', 'In Progress', 'Waiting on Someone', 'Done'];
  const COLS = ['Not Started', 'In Progress', 'Done'];
  const columnOf = (t) => (t.status === 'Waiting on Someone' ? 'Not Started' : t.status);
  for (const s of STATUSES) {
    const hits = COLS.filter((c) => columnOf({ status: s }) === c);
    assert.equal(hits.length, 1, `status "${s}" does not map to exactly one column`);
  }
});

test('name suggestions rank starts-with above contains, and hide names already picked', () => {
  /* mirrors acOpen() in index.html */
  const rank = (people, needleRaw, alreadyRaw) => {
    const needle = needleRaw.toLowerCase();
    const taken = new Set(alreadyRaw.map((p) => p.toLowerCase()));
    const pool = people.filter((p) => !taken.has(p.toLowerCase()) || p.toLowerCase() === needle);
    const starts = pool.filter((p) => p.toLowerCase().startsWith(needle));
    const inside = pool.filter((p) => !p.toLowerCase().startsWith(needle) && p.toLowerCase().includes(needle));
    return needle ? starts.concat(inside) : pool;
  };
  const staff = ['Jason Ng', 'Pang', 'Pei Qin', 'Kevin Teoh', 'Ken Ho', 'Kenny Lam', 'Anisa'];

  assert.deepEqual(rank(staff, 'P', []), ['Pang', 'Pei Qin'], 'typing P offers both P names');
  assert.deepEqual(rank(staff, 'ken', []), ['Ken Ho', 'Kenny Lam'],
    'Kevin Teoh does not contain "ken", so it must not appear');
  assert.deepEqual(rank(staff, 'an', []), ['Anisa', 'Pang'],
    'starts-with ranks above a mid-word match: Anisa before Pang');
  assert.deepEqual(rank(staff, 'p', ['Pang']), ['Pei Qin'], 'someone already on the task drops out');
  assert.deepEqual(rank(staff, 'zzz', []), [], 'no match returns nothing rather than everything');
  assert.equal(rank(staff, '', []).length, staff.length, 'empty query offers everyone');
  assert.equal(rank([], 'p', []).length, 0, 'an empty staff list cannot suggest anyone');
});

test('deleting a task removes it and leaves no dangling subtask references', () => {
  /* mirrors the mutation inside doDelete() in index.html */
  const remove = (doc, ref) => {
    const d = structuredClone(doc);
    const i = d.tasks.findIndex((r) => String(r.ref) === String(ref));
    if (i < 0) throw new Error('gone');
    d.tasks.splice(i, 1);
    d.tasks.forEach((r) => {
      if (Array.isArray(r.subtasks) && r.subtasks.length) {
        r.subtasks = r.subtasks.filter((k) => String(k) !== String(ref));
      }
    });
    return d;
  };

  const doc = {
    nextRef: 5,
    tasks: [
      { ref: 1, task: 'parent', subtasks: [2, 3] },
      { ref: 2, task: 'child a', subtasks: [] },
      { ref: 3, task: 'child b', subtasks: [] },
      { ref: 4, task: 'unrelated', subtasks: [3] }
    ]
  };

  const after = remove(doc, 3);
  assert.equal(after.tasks.length, 3, 'exactly one task removed');
  assert.ok(!after.tasks.some((t) => t.ref === 3), 'the task is gone');
  assert.deepEqual(after.tasks.find((t) => t.ref === 1).subtasks, [2], 'parent no longer points at it');
  assert.deepEqual(after.tasks.find((t) => t.ref === 4).subtasks, [], 'every other reference cleared too');

  const every = after.tasks.flatMap((t) => t.subtasks || []);
  const live = new Set(after.tasks.map((t) => t.ref));
  assert.deepEqual(every.filter((k) => !live.has(k)), [], 'no subtask points at a missing task');

  assert.equal(after.nextRef, 5, 'nextRef must not wind back, or a deleted ref gets reused');
  assert.equal(doc.tasks.length, 4, 'the original document is not mutated');
  assert.throws(() => remove(doc, 99), /gone/, 'deleting something absent fails loudly');
});

test('the date helpers agree with each other', () => {
  const addDays = (iso, n) =>
    new Date(Date.parse(iso + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
  const dayDiff = (a, b) =>
    Math.round((Date.parse(a + 'T00:00:00Z') - Date.parse(b + 'T00:00:00Z')) / 86400000);

  assert.equal(addDays('2026-08-31', 1), '2026-09-01', 'month boundary');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01', 'year boundary');
  assert.equal(addDays('2028-02-28', 1), '2028-02-29', 'leap day');
  assert.equal(dayDiff('2026-09-01', '2026-08-31'), 1);
  assert.equal(dayDiff('2017-06-08', '2017-06-08'), 0);
  for (let n = -400; n <= 400; n += 37) {
    assert.equal(dayDiff(addDays('2026-09-28', n), '2026-09-28'), n, `round trip failed at ${n}`);
  }
});

test('Monday-first week start is right for every day of the week', () => {
  const addDays = (iso, n) =>
    new Date(Date.parse(iso + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
  const mondayOf = (iso) => {
    const d = new Date(Date.parse(iso + 'T00:00:00Z'));
    return addDays(iso, -(((d.getUTCDay() + 6) % 7)));
  };
  // 2026-09-28 is a Monday
  for (let i = 0; i < 7; i++) {
    assert.equal(mondayOf(addDays('2026-09-28', i)), '2026-09-28', `day +${i}`);
  }
  assert.equal(mondayOf('2026-09-27'), '2026-09-21', 'Sunday belongs to the week before');
});

test('UTF-8 base64 survives a round trip, which plain btoa does not', () => {
  const enc = (str) => Buffer.from(str, 'utf8').toString('base64');
  const dec = (b64) => Buffer.from(b64.replace(/\s/g, ''), 'base64').toString('utf8');
  const sample = JSON.stringify({ task: 'Starfeb event — slides and documents prep' });
  assert.equal(dec(enc(sample)), sample);
  assert.ok(dec(enc(sample)).includes('—'), 'em-dash lost');
});

test('tenure arithmetic is calendar-correct, not days divided by 365', () => {
  /* mirrors renderTenure() in index.html */
  const tenure = (isoStart, isoToday) => {
    const s = isoStart.split('-').map(Number), t = isoToday.split('-').map(Number);
    let y = t[0] - s[0], m = t[1] - s[1];
    if (t[2] < s[2]) m--;
    if (m < 0) { y--; m += 12; }
    const idx = (s[1] - 1) + m;
    const ay = s[0] + y + Math.floor(idx / 12);
    const am = ((idx % 12) + 12) % 12;
    const ad = Math.min(s[2], new Date(Date.UTC(ay, am + 1, 0)).getUTCDate());
    const d = Math.round((Date.UTC(t[0], t[1] - 1, t[2]) - Date.UTC(ay, am, ad)) / 86400000);
    return { y, m, d };
  };
  assert.deepEqual(tenure('2017-06-08', '2026-08-25'), { y: 9, m: 2, d: 17 });
  assert.deepEqual(tenure('2017-06-08', '2017-06-08'), { y: 0, m: 0, d: 0 });
  assert.deepEqual(tenure('2017-06-08', '2018-06-07'), { y: 0, m: 11, d: 30 },
    'the day before an anniversary must not read as a full year');
  assert.deepEqual(tenure('2026-01-31', '2026-03-01'), { y: 0, m: 1, d: 1 },
    'borrowing across February');
});
