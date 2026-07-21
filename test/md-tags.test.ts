import { test, expect } from 'bun:test'
import { MD_TAG_TIERS } from '../src/commands/root'

const { zeroFootprint, replaced, widget, structured, block } = MD_TAG_TIERS

const intersect = (a: Set<string>, b: Set<string>) => [...a].filter((t) => b.has(t))

test('md tag tiers: skip tiers are pairwise disjoint', () => {
  expect(intersect(zeroFootprint, replaced)).toEqual([])
  expect(intersect(zeroFootprint, widget)).toEqual([])
  expect(intersect(replaced, widget)).toEqual([])
})

test('md tag tiers: skip tiers never overlap block tags', () => {
  expect(intersect(zeroFootprint, block)).toEqual([])
  expect(intersect(replaced, block)).toEqual([])
  expect(intersect(widget, block)).toEqual([])
})

test('md tag tiers: structured tags are all block tags', () => {
  expect([...structured].filter((t) => !block.has(t))).toEqual([])
})
