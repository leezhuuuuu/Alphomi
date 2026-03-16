import type { Page } from 'playwright'
import { loadConfigFromYaml } from '../../common/config'
import { LocatorRecipe } from '../../types/protocol'
import { AXNode, captureAxTree } from './ax-tree'

loadConfigFromYaml('driver')

const parseNonNegativeInt = (value: string | undefined, fallback: number): number => {
  const parsed = value ? Number(value) : NaN
  if (!Number.isFinite(parsed)) return fallback
  const normalized = Math.floor(parsed)
  if (normalized < 0) return fallback
  return normalized
}

// 获取配置并设置默认值
const LIST_THRESHOLD = parseNonNegativeInt(process.env.SNAPSHOT_LIST_THRESHOLD, 10)
const LIST_HEAD = parseNonNegativeInt(process.env.SNAPSHOT_LIST_HEAD, 5)
const LIST_TAIL = parseNonNegativeInt(process.env.SNAPSHOT_LIST_TAIL, 2)

export class Snapshotter {
  private _refCounter = 0
  private readonly _refByIdentity = new Map<string, string>()
  public readonly refs = new Map<string, LocatorRecipe>()

  constructor(private page: Page) {}

  async capture(full: boolean = false): Promise<string> {
    this.refs.clear()

    try {
      const root = await captureAxTree(this.page)
      if (!root) return 'No content'

      const lines: string[] = []
      const identityUseCounter = new Map<string, number>()
      const roleNameUseCounter = new Map<string, number>()
      const seenRefIdentities = new Set<string>()
      this._renderNode(root, 0, lines, full, [], identityUseCounter, roleNameUseCounter, seenRefIdentities)

      for (const identity of Array.from(this._refByIdentity.keys())) {
        if (!seenRefIdentities.has(identity)) {
          this._refByIdentity.delete(identity)
        }
      }

      return lines.join('\n')
    } catch (e) {
      return `Error capturing snapshot: ${e instanceof Error ? e.message : String(e)}`
    }
  }

  private _renderNode(
    node: AXNode | undefined,
    indent: number,
    lines: string[],
    full: boolean,
    path: string[],
    identityUseCounter: Map<string, number>,
    roleNameUseCounter: Map<string, number>,
    seenRefIdentities: Set<string>
  ) {
    if (!node) return;
    const role = (node.role || '').toLowerCase();
    
    // 🟢 核心修改 1: 强力黑名单
    // 仅过滤 InlineTextBox。WebArea 不能在这里 return，否则会丢失整个页面！
    if (role === 'inlinetextbox') return;

    // 🟢 核心修改 2: 智能扁平化逻辑
    // 如果是 generic/none/webarea/paragraph/presentation 等容器，
    // 且没有名字，且不是可交互元素，则视为"噪音容器"。
    // 策略：跳过该节点的渲染，直接处理其子节点，且**不增加缩进**。
    const isUselessContainer =
      (role === 'generic' || role === 'none' || role === 'paragraph' || role === 'presentation' || role === 'webarea') &&
      !node.name &&
      !this._isInteractive(node);

    const currentPath = isUselessContainer ? path : [...path, this._buildPathSegment(node)];
    
    // 🟢 列表压缩逻辑
    if (!full && (role === 'list' || role === 'grid')) {
        const children = node.children || [];
        
        // 使用环境变量控制阈值
        if (children.length > LIST_THRESHOLD) {
            const headCount = Math.min(LIST_HEAD, children.length);
            const maxTail = Math.max(0, children.length - headCount);
            const tailCount = Math.min(LIST_TAIL, maxTail);
            
            if (!isUselessContainer) {
                 lines.push('  '.repeat(indent) + this._formatNode(node, currentPath, identityUseCounter, roleNameUseCounter, seenRefIdentities));
            }
            const nextIndent = isUselessContainer ? indent : indent + 1;

            // A. Head
            for (let i = 0; i < headCount; i++) {
                this._renderNode(children[i], nextIndent, lines, full, currentPath, identityUseCounter, roleNameUseCounter, seenRefIdentities);
            }

            // B. Ellipsis
            const hiddenCount = children.length - headCount - tailCount;
            if (hiddenCount > 0) {
              lines.push('  '.repeat(nextIndent) + `- ... (${hiddenCount} more items hidden)`);
            }

            // C. Tail
            for (let i = children.length - tailCount; i < children.length; i++) {
                this._renderNode(children[i], nextIndent, lines, full, currentPath, identityUseCounter, roleNameUseCounter, seenRefIdentities);
            }
            
            return;
        }
    }
    
    // 3. 决定是否渲染当前节点
    if (!isUselessContainer) {
      const line = this._formatNode(node, currentPath, identityUseCounter, roleNameUseCounter, seenRefIdentities);
      lines.push('  '.repeat(indent) + line);
    }

    // 4. 递归子节点
    // 如果当前节点被"跳过"了，子节点继承当前缩进
    const nextIndent = isUselessContainer ? indent : indent + 1;
    
    if (node.children) {
      for (const child of node.children) {
        this._renderNode(child, nextIndent, lines, full, currentPath, identityUseCounter, roleNameUseCounter, seenRefIdentities);
      }
    }
  }

  private _isInteractive(node: AXNode): boolean {
    // 扩展交互角色列表
    const interactiveRoles = new Set([
      'button', 'checkbox', 'combobox', 'link', 'menuitem', 'menuitemcheckbox',
      'menuitemradio', 'option', 'radio', 'searchbox', 'slider', 'spinbutton',
      'switch', 'tab', 'textbox', 'treeitem', 'gridcell', 'listbox'
    ]);
    const role = (node.role || '').toLowerCase();
    
    return interactiveRoles.has(role) || 
           node.checked !== undefined || 
           node.selected !== undefined ||
           node.expanded !== undefined; // 增加 expanded，防止折叠菜单无法点击
  }

  // 格式化逻辑
  private _formatNode(
    node: AXNode,
    path: string[],
    identityUseCounter: Map<string, number>,
    roleNameUseCounter: Map<string, number>,
    seenRefIdentities: Set<string>
  ): string {
    const parts: string[] = [];
    const role = node.role || 'generic';
    const normalizedName = this._normalizeDisplayName(node.name);
    
    // 1. Role
    parts.push(`- ${role}`);
    
    // 2. Name
    if (normalizedName) parts.push(`"${normalizedName}"`);

    // 3. 核心状态
    if (node.disabled) parts.push('[disabled]');
    if (node.required) parts.push('[required]');
    if (node.checked === true) parts.push('[checked]');
    if (node.expanded === true) parts.push('[expanded]');
    if (node.focused) parts.push('[focused]');

    // 4. Value (带截断)
    if (node.value !== undefined && node.value !== '' && String(node.value).trim().length > 0) {
      const valStr = JSON.stringify(node.value);
      parts.push(`value=${valStr.length > 50 ? valStr.substring(0, 47) + '..."' : valStr}`);
    }

    // 5. Ref Generation
    if (this._isInteractive(node) || node.name) {
      const identity = this._buildNodeIdentity(node, path, identityUseCounter);
      const roleNameKey = `${role.toLowerCase()}|${this._normalizeIdentityToken(normalizedName || node.name)}`;
      const matchIndex = roleNameUseCounter.get(roleNameKey) || 0;
      roleNameUseCounter.set(roleNameKey, matchIndex + 1);
      const refId = this._resolveRefId(identity);
      seenRefIdentities.add(identity);
      parts.push(`[ref=${refId}]`);
      
      this.refs.set(refId, {
        role: node.role,
        name: normalizedName || node.name,
        matchIndex,
      });
    }

    return parts.join(' ');
  }

  private _resolveRefId(identity: string): string {
    const existing = this._refByIdentity.get(identity);
    if (existing) return existing;
    const refId = `e${++this._refCounter}`;
    this._refByIdentity.set(identity, refId);
    return refId;
  }

  private _buildNodeIdentity(node: AXNode, path: string[], identityUseCounter: Map<string, number>): string {
    const role = (node.role || 'generic').toLowerCase();
    const name = this._normalizeIdentityToken(node.name);
    const pathKey = path.join('>');
    const base = `${pathKey}|${role}|${name}`;
    const count = (identityUseCounter.get(base) || 0) + 1;
    identityUseCounter.set(base, count);
    return `${base}#${count}`;
  }

  private _buildPathSegment(node: AXNode): string {
    const role = (node.role || 'generic').toLowerCase();
    const name = this._normalizeIdentityToken(node.name);
    return `${role}:${name}`;
  }

  private _normalizeIdentityToken(value?: string): string {
    if (!value) return '_';
    return value
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase()
      .slice(0, 80);
  }

  private _normalizeDisplayName(value?: string): string {
    if (!value) return '';
    const cleaned = value
      .replace(/[\uE000-\uF8FF]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return cleaned || value.trim();
  }
}
