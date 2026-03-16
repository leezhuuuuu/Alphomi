import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const schemasDir = path.resolve(__dirname, '..', 'schemas')

const ajv = new Ajv2020({
  allErrors: true,
  strict: false
})
addFormats(ajv)

const fixtures = {
  'port-registry.schema.json': {
    driver: {
      port: 13000,
      url: 'http://127.0.0.1:13000',
      ready: true,
      updatedAt: '2026-03-16T00:00:00.000Z'
    },
    brain: {
      port: 18000,
      url: 'http://127.0.0.1:18000',
      updatedAt: '2026-03-16T00:00:00.000Z'
    }
  },
  'tool-discovery.schema.json': [
    {
      name: 'browser_navigate',
      description: 'Navigate to a URL',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string' }
        }
      }
    }
  ],
  'ws-event-envelope.schema.json': {
    type: 'message',
    data: {
      text: 'hello'
    }
  }
}

const files = (await readdir(schemasDir)).filter((name) => name.endsWith('.json')).sort()

if (files.length === 0) {
  throw new Error(`No schema files found in ${schemasDir}`)
}

for (const file of files) {
  const fullPath = path.join(schemasDir, file)
  const raw = await readFile(fullPath, 'utf8')
  const schema = JSON.parse(raw)

  if (!schema.$id || !schema.title) {
    throw new Error(`${file} must include both $id and title`)
  }

  const validate = ajv.compile(schema)
  const fixture = fixtures[file]
  if (!fixture) {
    throw new Error(`Missing fixture for ${file}`)
  }

  const valid = validate(fixture)
  if (!valid) {
    throw new Error(`${file} fixture failed validation: ${ajv.errorsText(validate.errors)}`)
  }
}

console.log(`[contracts] validated ${files.length} schemas`)
