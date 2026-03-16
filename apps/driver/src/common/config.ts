import fs from 'fs';
import path from 'path';
import { parse } from 'yaml';

const CONFIG_NAMES = ['config.yaml', 'config.yml'];

const findConfigPath = (startDir: string): string | null => {
  let current = startDir;
  while (true) {
    for (const name of CONFIG_NAMES) {
      const candidate = path.join(current, name);
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
};

const normalizeEnvValue = (value: unknown): string => {
  if (Array.isArray(value)) {
    return value.map((item) => String(item)).join(',');
  }
  if (value !== null && typeof value === 'object') {
    return JSON.stringify(value);
  }
  return String(value);
};

export const loadConfigFromYaml = (section?: string): void => {
  const configPath = findConfigPath(process.cwd());
  if (!configPath) {
    return;
  }

  const raw = fs.readFileSync(configPath, 'utf8');
  const parsed = parse(raw);
  if (!parsed || typeof parsed !== 'object') {
    return;
  }

  const scoped =
    section && typeof (parsed as Record<string, unknown>)[section] === 'object'
      ? (parsed as Record<string, unknown>)[section]
      : parsed;

  if (!scoped || typeof scoped !== 'object') {
    return;
  }

  for (const [key, value] of Object.entries(scoped as Record<string, unknown>)) {
    if (value === undefined || value === null) {
      continue;
    }
    if (process.env[key] !== undefined) {
      continue;
    }
    process.env[key] = normalizeEnvValue(value);
  }
};
