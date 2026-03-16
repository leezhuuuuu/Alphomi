#!/usr/bin/env node
/**
 * Snapshot 工具
 * 用法: node snapshot.mjs <url> [output_file]
 * 示例: node snapshot.mjs https://example.com result.txt
 *
 * 头部模式设置 (改为 false 可显示浏览器窗口):
 *   HEADLESS = true  - 无头模式 (默认)
 *   HEADLESS = false - 有界面模式
 */

// ============= 头部模式设置 =============
// const HEADLESS = true;  // 改为 false 可看到浏览器窗口
const HEADLESS = false;  // 改为 false 可看到浏览器窗口
// ========================================

import { chromium } from 'playwright';
import { writeFileSync } from 'fs';
import path from 'path';

const args = process.argv.slice(2);

if (args.length === 0) {
  console.error('用法: node snapshot.mjs <url> [output_file]');
  console.error('示例: node snapshot.mjs https://example.com result.txt');
  process.exit(1);
}

const url = args[0];
const outputFile = args[1] || 'snapshot.txt';
const outputPath = path.resolve(outputFile);

async function main() {
  console.log(`🚀 启动浏览器...`);
  console.log(`🌐 访问: ${url}`);

  const browser = await chromium.launch({ headless: HEADLESS });
  const page = await browser.newPage();

  // 捕获控制台消息
  const consoleMessages = [];
  page.on('console', msg => {
    consoleMessages.push(`[${msg.type()}] ${msg.text()}`);
  });

  // 捕获页面错误
  const pageErrors = [];
  page.on('pageerror', err => {
    pageErrors.push(err.message);
  });

  try {
    // 导航到页面
    console.log('⏳ 加载页面中...');
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
    console.log('✅ 页面加载完成');

    // 获取页面标题
    const title = await page.title();
    console.log(`📄 标题: ${title}`);

    // 获取 accessibility snapshot
    console.log('📸 捕获页面快照...');
    const snapshot = await page.accessibility.snapshot({ interestingOnly: false });

    if (!snapshot) {
      console.error('❌ 无法获取页面快照');
      await browser.close();
      process.exit(1);
    }

    // 构建输出内容
    const lines = [];

    // 头部信息
    lines.push('=' .repeat(60));
    lines.push(`URL: ${url}`);
    lines.push(`标题: ${title}`);
    lines.push(`时间: ${new Date().toISOString()}`);
    lines.push('=' .repeat(60));
    lines.push('');

    // 递归渲染节点
    function renderNode(node, indent) {
      const role = (node.role || '').toLowerCase();
      if (role === 'inlinetextbox') return;

      const parts = [];
      parts.push('  '.repeat(indent) + `- ${role}`);

      if (node.name) {
        parts.push(`"${node.name}"`);
      }

      if (node.disabled) parts.push('[disabled]');
      if (node.checked === true) parts.push('[checked]');
      if (node.focused) parts.push('[focused]');
      if (node.value !== undefined && node.value !== '') {
        parts.push(`value=${node.value}`);
      }

      // 可交互元素添加 ref
      const interactiveRoles = new Set([
        'button', 'checkbox', 'combobox', 'link', 'menuitem', 'menuitemcheckbox',
        'menuitemradio', 'option', 'radio', 'searchbox', 'slider', 'spinbutton',
        'switch', 'tab', 'textbox', 'treeitem', 'gridcell', 'listbox'
      ]);

      if (interactiveRoles.has(role) || node.name) {
        parts.push(`[ref=dynamic]`);
      }

      lines.push(parts.join(' '));

      if (node.children) {
        for (const child of node.children) {
          renderNode(child, indent + 1);
        }
      }
    }

    renderNode(snapshot, 0);
    lines.push('');
    lines.push('=' .repeat(60));

    // 控制台消息
    if (consoleMessages.length > 0) {
      lines.push('');
      lines.push('控制台消息:');
      lines.push('-'.repeat(40));
      consoleMessages.forEach(msg => lines.push(msg));
    }

    // 页面错误
    if (pageErrors.length > 0) {
      lines.push('');
      lines.push('页面错误:');
      lines.push('-'.repeat(40));
      pageErrors.forEach(err => lines.push(err));
    }

    // 额外信息
    lines.push('');
    lines.push('页面信息:');
    lines.push('-'.repeat(40));
    lines.push(`URL: ${page.url()}`);
    lines.push(`标题: ${await page.title()}`);

    // 写入文件
    const content = lines.join('\n');
    writeFileSync(outputPath, content, 'utf-8');

    console.log(`✅ 快照已保存到: ${outputPath}`);
    console.log(`📊 文件大小: ${(content.length / 1024).toFixed(2)} KB`);

  } catch (error) {
    console.error(`❌ 错误: ${error instanceof Error ? error.message : error}`);
    await browser.close();
    process.exit(1);
  } finally {
    await browser.close();
    console.log('🔒 浏览器已关闭');
  }
}

main();
