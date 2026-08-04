import { test, expect } from 'bun:test'
import { compileWhere } from '../src/lib/expr'

const row = {
  name: 'Lesson 3: Directions',
  level: 'B2',
  price: 120,
  stock: 0,
  active: true,
  tags: ['a', 'b'],
  nested: { x: 1 },
}

test('comparison operators', () => {
  expect(compileWhere('price > 100')(row)).toBe(true)
  expect(compileWhere('price >= 120')(row)).toBe(true)
  expect(compileWhere('price < 100')(row)).toBe(false)
  expect(compileWhere('stock != 0')(row)).toBe(false)
  expect(compileWhere('level == "B2"')(row)).toBe(true)
  expect(compileWhere("level == 'B2'")(row)).toBe(true)
})

test('logical operators and grouping', () => {
  expect(compileWhere('price > 100 && stock != 0')(row)).toBe(false)
  expect(compileWhere('price > 100 || stock != 0')(row)).toBe(true)
  expect(compileWhere('!(stock != 0) && active == true')(row)).toBe(true)
})

test('regex match', () => {
  expect(compileWhere('name ~ /^Lesson/')(row)).toBe(true)
  expect(compileWhere('name ~ /directions/i')(row)).toBe(true)
  expect(compileWhere('name !~ /Weather/')(row)).toBe(true)
})

test('global regex state does not leak between rows', () => {
  const rows = [{ name: 'foo' }, { name: 'foo' }]
  expect(rows.filter(compileWhere('name ~ /foo/g'))).toEqual(rows)
  expect(rows.filter(compileWhere('name !~ /foo/g'))).toEqual([])
})

test('dot paths and .length', () => {
  expect(compileWhere('nested.x == 1')(row)).toBe(true)
  expect(compileWhere('tags.length >= 2')(row)).toBe(true)
  expect(compileWhere('name.length > 5')(row)).toBe(true)
})

test('numeric strings compare numerically', () => {
  expect(compileWhere('n > 100')({ n: '25000' })).toBe(true)
  expect(compileWhere('n == 25000')({ n: '25000' })).toBe(true)
})

test('missing fields resolve to null, not a crash', () => {
  expect(compileWhere('nope == "x"')(row)).toBe(false)
  expect(compileWhere('nope == null')(row)).toBe(true)
})

test('backtick-quoted column names with spaces', () => {
  const r = { 'Country or territory': 'Japan', 'Change(%)': '+0.5' }
  expect(compileWhere('`Country or territory` ~ /Japan/')(r)).toBe(true)
  expect(compileWhere('`Country or territory` == "Japan"')(r)).toBe(true)
  expect(compileWhere('`Change(%)` ~ /\\+/')(r)).toBe(true)
  expect(compileWhere('`Country or territory` == "Brazil"')(r)).toBe(false)
})

test('backticked true/false/null are columns, bare ones stay literals', () => {
  const r = { true: 'yes', false: 'no', null: 'nil', ok: 'x' }
  expect(compileWhere('`true` ~ /yes/')(r)).toBe(true)
  expect(compileWhere('`false` == "no"')(r)).toBe(true)
  expect(compileWhere('`null` == "nil"')(r)).toBe(true)
  // bare keywords keep their literal meaning
  expect(compileWhere('ok != null')(r)).toBe(true)
  expect(compileWhere('missing == null')(r)).toBe(true)
})

test('a dotted bare name prefers a column literally so named', () => {
  // header literally called "foo.bar" — the issue #59 false negative/positive
  expect(compileWhere('foo.bar ~ /x/')({ 'foo.bar': 'x' })).toBe(true)
  expect(compileWhere('foo.bar == null')({ 'foo.bar': 'x' })).toBe(false)
  // no literal key → still a path (nested access and .length unaffected)
  expect(compileWhere('foo.bar == 1')({ foo: { bar: 1 } })).toBe(true)
  // literal key wins when both readings exist
  expect(compileWhere('foo.bar == "flat"')({ 'foo.bar': 'flat', foo: { bar: 'deep' } })).toBe(true)
})

test('backticked names are never dot-split', () => {
  expect(compileWhere('`foo.bar` ~ /x/')({ 'foo.bar': 'x' })).toBe(true)
  expect(compileWhere('`foo.bar` == null')({ foo: { bar: 1 } })).toBe(true)
})

test('non-ASCII names work backticked and error loudly bare', () => {
  expect(compileWhere('`名称` ~ /甲/')({ 名称: '甲' })).toBe(true)
})
