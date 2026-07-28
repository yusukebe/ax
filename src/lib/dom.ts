// linkedom runs in scriptc's embedded engine, so its nodes arrive as dynamic
// values. scriptc refuses to validate a dynamic value against a structural
// interface, which rules out a hand-written `Element` type — DOM nodes stay
// untyped here and only leaf values get narrowed at the point of use.
export type DomNode = any

/**
 * Copy a live DOM collection into a real array.
 *
 * Spreading a dynamic value (`[...el.children]`) has no scriptc lowering, so
 * every NodeList/HTMLCollection is materialised through this instead.
 */
export function toArray(nodes: DomNode): DomNode[] {
  const out: DomNode[] = []
  for (const n of nodes) out.push(n)
  return out
}

/** Copy a dynamic collection of strings (classList, attribute names). */
export function toStrings(values: DomNode): string[] {
  const out: string[] = []
  for (const v of values) out.push(v as string)
  return out
}

// Map keys are limited to strings and numbers, so identity memoization tags
// each node with a serial number the first time it is seen. The property lives
// on the node itself, which is exactly the lifetime a WeakMap entry had.
const ID_KEY = '__axNodeId'
let nextNodeId = 0

/** Stable per-node number, usable as a Map key in place of node identity. */
export function nodeId(el: DomNode): number {
  if (typeof el[ID_KEY] !== 'number') {
    el[ID_KEY] = nextNodeId
    nextNodeId++
  }
  return el[ID_KEY] as number
}
