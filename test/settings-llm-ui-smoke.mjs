#!/usr/bin/env node
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const playwrightModulePath = require.resolve('playwright', {
  paths: [path.join(ROOT_DIR, 'apps/driver')]
});
const { chromium } = require(playwrightModulePath);
const SETTINGS_URL = pathToFileURL(
  path.join(ROOT_DIR, 'apps/desktop/src/renderer/settings.html')
).href;

function createScenarioState(scenario) {
  const baseState = {
    settings: {
      themeMode: 'light',
      newTabUrl: 'https://example.com',
      toolStates: { browser_navigate: true }
    },
    toolCatalog: [
      {
        id: 'browser',
        title: 'Browser',
        description: 'Browser tools',
        tools: [
          {
            name: 'browser_navigate',
            label: 'Navigate',
            description: 'Navigate to a URL',
            scope: 'browser'
          }
        ]
      }
    ],
    calls: {
      updateSettings: [],
      updateLLMSettings: [],
      testLLMSettings: []
    }
  };

  if (scenario === 'config-derived') {
    return {
      ...baseState,
      llmSettings: {
        activeProfileId: null,
        profiles: []
      },
      effective: {
        providerType: 'openai_compatible',
        activeProfileId: null,
        activeProfileLabel: null,
        baseUrl: 'https://config-provider.example/v1',
        model: 'config-model',
        endpointMode: 'responses',
        apiKey: '',
        hasApiKey: false,
        sources: {
          baseUrl: 'config',
          model: 'config',
          endpointMode: 'config',
          apiKey: 'unset'
        }
      }
    };
  }

  return {
    ...baseState,
    llmSettings: {
      activeProfileId: 'main',
      profiles: [
        {
          id: 'main',
          label: 'OpenRouter Main',
          providerType: 'openai_compatible',
          baseUrl: 'https://openrouter.ai/api/v1',
          model: 'openai/gpt-4.1-mini',
          endpointMode: 'auto',
          hasApiKey: true
        }
      ]
    },
    effective: {
      providerType: 'openai_compatible',
      activeProfileId: 'main',
      activeProfileLabel: 'OpenRouter Main',
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'openai/gpt-4.1-mini',
      endpointMode: 'auto',
      apiKey: '',
      hasApiKey: true,
      sources: {
        baseUrl: 'user',
        model: 'user',
        endpointMode: 'user',
        apiKey: 'user'
      }
    }
  };
}

async function createSettingsPage(browser, scenario) {
  const page = await browser.newPage();
  const state = createScenarioState(scenario);

  await page.addInitScript((initialState) => {
    const state = initialState;
    window.__settingsUiMock = state;
    window.api = {
      getSettings: async () => structuredClone(state.settings),
      getToolCatalog: async () => structuredClone(state.toolCatalog),
      getLLMSettings: async () => structuredClone(state.llmSettings),
      getEffectiveLLMSettings: async () => structuredClone(state.effective),
      updateSettings: async (patch) => {
        state.calls.updateSettings.push(structuredClone(patch));
        state.settings = {
          ...state.settings,
          ...patch,
          toolStates: { ...state.settings.toolStates, ...(patch.toolStates || {}) }
        };
        return structuredClone(state.settings);
      },
      updateLLMSettings: async (patch) => {
        state.calls.updateLLMSettings.push(structuredClone(patch));
        const previousProfiles = state.llmSettings.profiles;
        const nextProfiles = (patch.profiles || []).map((profile) => {
          const previous = previousProfiles.find((item) => item.id === profile.id);
          const hasApiKey =
            typeof profile.apiKey === 'string'
              ? profile.apiKey.trim().length > 0
              : Boolean(previous && previous.hasApiKey);
          return {
            id: profile.id,
            label: profile.label,
            providerType: 'openai_compatible',
            baseUrl: profile.baseUrl,
            model: profile.model,
            endpointMode: profile.endpointMode,
            hasApiKey
          };
        });
        state.llmSettings = {
          activeProfileId: patch.activeProfileId || (nextProfiles[0] ? nextProfiles[0].id : null),
          profiles: nextProfiles
        };
        const active =
          nextProfiles.find((profile) => profile.id === state.llmSettings.activeProfileId) ||
          nextProfiles[0] ||
          null;
        state.effective = {
          providerType: 'openai_compatible',
          activeProfileId: active ? active.id : null,
          activeProfileLabel: active ? active.label : null,
          baseUrl: active ? active.baseUrl : state.effective.baseUrl,
          model: active ? active.model : state.effective.model,
          endpointMode: active ? active.endpointMode : state.effective.endpointMode,
          apiKey: '',
          hasApiKey: Boolean(active && active.hasApiKey),
          sources: {
            baseUrl: active ? 'user' : state.effective.sources.baseUrl,
            model: active ? 'user' : state.effective.sources.model,
            endpointMode: active ? 'user' : state.effective.sources.endpointMode,
            apiKey: active && active.hasApiKey ? 'user' : 'unset'
          }
        };
        return structuredClone(state.llmSettings);
      },
      testLLMSettings: async (input) => {
        state.calls.testLLMSettings.push(structuredClone(input));
        return {
          ok: true,
          statusCode: 200,
          latencyMs: 42,
          endpointMode: input.endpointMode === 'responses' ? 'responses' : 'chat_completions',
          requestUrl:
            input.endpointMode === 'responses'
              ? `${input.baseUrl.replace(/\/+$/, '')}/responses`
              : `${input.baseUrl.replace(/\/+$/, '')}/chat/completions`,
          model: input.model || 'unknown-model',
          preview: 'PONG'
        };
      }
    };
  }, state);

  await page.goto(`${SETTINGS_URL}?scenario=${scenario}`);
  await page.waitForSelector('text=LLM Provider');
  return page;
}

async function runUserProfileScenario(browser) {
  const page = await createSettingsPage(browser, 'user-profile');

  try {
    await page.waitForSelector('text=OpenRouter Main');

    assert.equal(await page.locator('#llm-profile-editor').isVisible(), true);
    assert.equal(await page.locator('#llm-effective-summary').isVisible(), true);

    await page.click('#llm-add-profile');
    await page.fill('#llm-profile-label', 'New Provider');
    await page.fill('#llm-base-url', 'https://provider.example/v1');
    await page.fill('#llm-model', 'custom-model');
    await page.selectOption('#llm-endpoint-mode', 'responses');
    await page.fill('#llm-api-key', 'secret-123');

    await page.click('#llm-test-btn');
    await page.waitForSelector('text=连接成功，Provider 已返回响应。');

    const testCalls = await page.evaluate(() => window.__settingsUiMock.calls.testLLMSettings);
    assert.equal(testCalls.length, 1);
    assert.equal(testCalls[0].baseUrl, 'https://provider.example/v1');
    assert.equal(testCalls[0].model, 'custom-model');
    assert.equal(testCalls[0].endpointMode, 'responses');
    assert.equal(testCalls[0].apiKey, 'secret-123');

    await page.click('#save-btn');
    await page.waitForSelector('text=设置已保存。');

    const calls = await page.evaluate(() => window.__settingsUiMock.calls);
    assert.equal(calls.updateSettings.length, 1);
    assert.equal(calls.updateLLMSettings.length, 1);
    assert.equal(calls.updateLLMSettings[0].profiles.length, 2);
    assert.equal(calls.updateLLMSettings[0].profiles[1].label, 'New Provider');
    assert.equal(calls.updateLLMSettings[0].profiles[1].baseUrl, 'https://provider.example/v1');
    assert.equal(calls.updateLLMSettings[0].profiles[1].model, 'custom-model');
    assert.equal(calls.updateLLMSettings[0].profiles[1].endpointMode, 'responses');
    assert.equal(calls.updateLLMSettings[0].profiles[1].apiKey, 'secret-123');

    const effectiveText = await page.locator('#llm-effective-summary').textContent();
    assert.match(effectiveText || '', /New Provider/);
  } finally {
    await page.close();
  }
}

async function runConfigDerivedScenario(browser) {
  const page = await createSettingsPage(browser, 'config-derived');

  try {
    await page.waitForSelector('text=Config Default');
    await page.waitForSelector('text=Base URL');

    assert.equal(await page.inputValue('#llm-profile-label'), 'Config Default');
    assert.equal(
      await page.inputValue('#llm-base-url'),
      'https://config-provider.example/v1'
    );
    assert.equal(await page.inputValue('#llm-model'), 'config-model');

    const profileListText = await page.locator('#llm-profile-list').textContent();
    assert.match(profileListText || '', /Config/);

    await page.click('#save-btn');
    await page.waitForSelector('text=设置已保存。');

    let calls = await page.evaluate(() => window.__settingsUiMock.calls);
    assert.equal(calls.updateSettings.length, 1);
    assert.equal(calls.updateLLMSettings.length, 0);

    await page.fill('#llm-profile-label', 'Config Override');
    await page.fill('#llm-model', 'override-model');
    await page.click('#save-btn');
    await page.waitForSelector('text=设置已保存。');

    calls = await page.evaluate(() => window.__settingsUiMock.calls);
    assert.equal(calls.updateSettings.length, 2);
    assert.equal(calls.updateLLMSettings.length, 1);
    assert.equal(calls.updateLLMSettings[0].profiles.length, 1);
    assert.equal(calls.updateLLMSettings[0].profiles[0].label, 'Config Override');
    assert.equal(calls.updateLLMSettings[0].profiles[0].model, 'override-model');
    assert.notEqual(calls.updateLLMSettings[0].profiles[0].id, '__derived_runtime_profile__');

    const effectiveText = await page.locator('#llm-effective-summary').textContent();
    assert.match(effectiveText || '', /Config Override/);
    assert.match(effectiveText || '', /User/);
  } finally {
    await page.close();
  }
}

const browser = await chromium.launch({ headless: true });

try {
  await runUserProfileScenario(browser);
  await runConfigDerivedScenario(browser);
  console.log('[settings-llm-ui-smoke] passed');
} finally {
  await browser.close();
}
