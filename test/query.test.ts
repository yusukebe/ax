import { test, expect } from 'bun:test'
import { runQuery, toTsv } from '../src/lib/query'

const data = {
  meta: { total: 2, 'weird key': 'w' },
  items: [
    { name: 'a', price: 10, tags: ['x'] },
    { name: 'b', price: 20, tags: ['y', 'z'] },
  ],
}

test('path language', () => {
  expect(runQuery(data, '.')).toEqual(data)
  expect(runQuery(data, '.meta.total')).toBe(2)
  expect(runQuery(data, '.items[0].name')).toBe('a')
  expect(runQuery(data, '.items[].name')).toEqual(['a', 'b'])
  expect(runQuery(data, '.meta["weird key"]')).toBe('w')
})

test('jq-compat leading .[', () => {
  expect(runQuery([{ a: 1 }, { a: 2 }], '.[0].a')).toBe(1)
  expect(runQuery([{ a: 1 }, { a: 2 }], '.[].a')).toEqual([1, 2])
})

test('toTsv: header once, rows tab-separated', () => {
  const rows = [
    { name: 'a', price: 10 },
    { name: 'b', price: 20 },
  ]
  expect(toTsv(rows)).toEqual(['name\tprice', 'a\t10', 'b\t20'])
})

test('toTsv: scalars pass through, nested values JSON-encoded', () => {
  expect(toTsv(['x', 'y'])).toEqual(['x', 'y'])
  expect(toTsv([{ a: { b: 1 } }])).toEqual(['a', '{"b":1}'])
})
