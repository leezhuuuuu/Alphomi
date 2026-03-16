import type { CDPSession, Page } from 'playwright'

export type AXNode = {
  role: string
  name?: string
  value?: string | number
  description?: string
  keyshortcuts?: string
  roledescription?: string
  valuetext?: string
  disabled?: boolean
  expanded?: boolean
  focused?: boolean
  modal?: boolean
  multiline?: boolean
  multiselectable?: boolean
  readonly?: boolean
  required?: boolean
  selected?: boolean
  checked?: boolean | 'mixed'
  pressed?: boolean | 'mixed'
  level?: number
  valuemin?: number
  valuemax?: number
  autocomplete?: string
  haspopup?: string
  invalid?: string
  orientation?: string
  children?: AXNode[]
}

type LegacyAccessibilityPage = Page & {
  accessibility?: {
    snapshot(options?: { interestingOnly?: boolean }): Promise<AXNode | null>
  }
}

type CdpValue = {
  type?: string
  value?: unknown
}

type CdpProperty = {
  name: string
  value?: CdpValue
}

type CdpAXNode = {
  nodeId: string
  role?: CdpValue
  name?: CdpValue
  value?: CdpValue
  description?: CdpValue
  properties?: CdpProperty[]
  childIds?: string[]
  parentId?: string
}

const LEGACY_ROLE_MAP: Record<string, string> = {
  RootWebArea: 'WebArea',
  StaticText: 'text',
}

export async function captureAxTree(page: Page): Promise<AXNode | null> {
  const legacyRoot = await captureViaLegacyApi(page)
  if (legacyRoot) return legacyRoot

  return captureViaCdp(page)
}

async function captureViaLegacyApi(page: Page): Promise<AXNode | null> {
  const legacyPage = page as LegacyAccessibilityPage
  const snapshot = legacyPage.accessibility?.snapshot
  if (typeof snapshot !== 'function') return null
  return snapshot.call(legacyPage.accessibility, { interestingOnly: false })
}

async function captureViaCdp(page: Page): Promise<AXNode | null> {
  const client = await createCdpSession(page)
  const response = (await client.send('Accessibility.getFullAXTree')) as { nodes?: CdpAXNode[] }
  const nodes = response.nodes || []
  if (nodes.length === 0) return null

  const nodeMap = new Map(nodes.map((node) => [node.nodeId, node]))
  const root =
    findRoot(nodes, nodeMap) ||
    nodes.find((node) => normalizeRole(readString(node.role) || 'generic') === 'WebArea') ||
    nodes[0]

  return buildNode(root, nodeMap, new Set())
}

async function createCdpSession(page: Page): Promise<CDPSession> {
  return page.context().newCDPSession(page)
}

function findRoot(nodes: CdpAXNode[], nodeMap: Map<string, CdpAXNode>): CdpAXNode | undefined {
  const roots = nodes.filter((node) => !node.parentId || !nodeMap.has(node.parentId))
  return roots.find((node) => normalizeRole(readString(node.role) || 'generic') === 'WebArea') || roots[0]
}

function buildNode(node: CdpAXNode | undefined, nodeMap: Map<string, CdpAXNode>, stack: Set<string>): AXNode | null {
  if (!node) return null
  if (stack.has(node.nodeId)) return null

  stack.add(node.nodeId)
  const properties = normalizeProperties(node.properties || [])

  const axNode: AXNode = {
    role: normalizeRole(readString(node.role) || 'generic'),
  }

  const name = readString(node.name)
  if (name !== undefined) axNode.name = name

  const value = readScalar(node.value) ?? readScalar(properties.value)
  if (typeof value === 'string' || typeof value === 'number') axNode.value = value

  const description = readString(node.description) ?? readString(properties.description)
  if (description !== undefined) axNode.description = description

  const keyshortcuts = readString(properties.keyshortcuts)
  if (keyshortcuts !== undefined) axNode.keyshortcuts = keyshortcuts

  const roledescription = readString(properties.roledescription)
  if (roledescription !== undefined) axNode.roledescription = roledescription

  const valuetext = readString(properties.valuetext)
  if (valuetext !== undefined) axNode.valuetext = valuetext

  assignBooleanish(axNode, 'disabled', properties.disabled)
  assignBooleanish(axNode, 'expanded', properties.expanded)
  assignBooleanish(axNode, 'focused', properties.focused)
  assignBooleanish(axNode, 'modal', properties.modal)
  assignBooleanish(axNode, 'multiline', properties.multiline)
  assignBooleanish(axNode, 'multiselectable', properties.multiselectable)
  assignBooleanish(axNode, 'readonly', properties.readonly)
  assignBooleanish(axNode, 'required', properties.required)
  assignBooleanish(axNode, 'selected', properties.selected)

  const checked = readMixedBoolean(properties.checked)
  if (checked !== undefined) axNode.checked = checked

  const pressed = readMixedBoolean(properties.pressed)
  if (pressed !== undefined) axNode.pressed = pressed

  assignNumber(axNode, 'level', properties.level)
  assignNumber(axNode, 'valuemin', properties.valuemin)
  assignNumber(axNode, 'valuemax', properties.valuemax)

  const autocomplete = readString(properties.autocomplete)
  if (autocomplete !== undefined) axNode.autocomplete = autocomplete

  const haspopup = readString(properties.haspopup)
  if (haspopup !== undefined) axNode.haspopup = haspopup

  const invalid = readString(properties.invalid)
  if (invalid !== undefined) axNode.invalid = invalid

  const orientation = readString(properties.orientation)
  if (orientation !== undefined) axNode.orientation = orientation

  const children = (node.childIds || [])
    .map((childId) => buildNode(nodeMap.get(childId), nodeMap, stack))
    .filter((child): child is AXNode => child !== null)
  if (children.length > 0) {
    axNode.children = children
  }

  stack.delete(node.nodeId)
  return axNode
}

function normalizeRole(role: string): string {
  if (LEGACY_ROLE_MAP[role]) return LEGACY_ROLE_MAP[role]
  return role
}

function normalizeProperties(properties: CdpProperty[]): Record<string, CdpValue | undefined> {
  const normalized: Record<string, CdpValue | undefined> = {}
  for (const property of properties) {
    normalized[property.name.toLowerCase()] = property.value
  }
  return normalized
}

function readScalar(value: CdpValue | undefined): unknown {
  return value?.value
}

function readString(value: CdpValue | undefined): string | undefined {
  const scalar = readScalar(value)
  if (scalar === undefined || scalar === null) return undefined
  return String(scalar)
}

function readNumber(value: CdpValue | undefined): number | undefined {
  const scalar = readScalar(value)
  if (typeof scalar === 'number' && Number.isFinite(scalar)) return scalar
  if (typeof scalar === 'string' && scalar.trim().length > 0) {
    const parsed = Number(scalar)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

function readBooleanish(value: CdpValue | undefined): boolean | undefined {
  const scalar = readScalar(value)
  if (typeof scalar === 'boolean') return scalar
  if (scalar === 'true') return true
  if (scalar === 'false') return false
  return undefined
}

function readMixedBoolean(value: CdpValue | undefined): boolean | 'mixed' | undefined {
  const scalar = readScalar(value)
  if (scalar === 'mixed') return 'mixed'
  return readBooleanish(value)
}

function assignBooleanish<T extends keyof AXNode>(target: AXNode, key: T, value: CdpValue | undefined) {
  const normalized = readBooleanish(value)
  if (normalized !== undefined) {
    target[key] = normalized as AXNode[T]
  }
}

function assignNumber<T extends keyof AXNode>(target: AXNode, key: T, value: CdpValue | undefined) {
  const normalized = readNumber(value)
  if (normalized !== undefined) {
    target[key] = normalized as AXNode[T]
  }
}
