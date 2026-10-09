// Refresh the ad/tracker filter lists bundled with the app (resources/filters).
// The app never downloads lists at runtime; run this before a release to update them.
//
// The set matches Ghostery's "ads and tracking" preset: EasyList + EasyPrivacy, Peter Lowe's
// list, and uBlock Origin's lists. uBlock's lists carry the site-specific rules (for example
// YouTube video ads) that need scriptlets, which come from uBlock's resources.json.
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const BASE = 'https://raw.githubusercontent.com/ghostery/adblocker/master/packages/adblocker/assets'
const LISTS = [
  'easylist/easylist.txt',
  'easylist/easyprivacy.txt',
  'peter-lowe/serverlist.txt',
  'ublock-origin/badware.txt',
  'ublock-origin/filters-2020.txt',
  'ublock-origin/filters-2021.txt',
  'ublock-origin/filters-2022.txt',
  'ublock-origin/filters-2023.txt',
  'ublock-origin/filters-2024.txt',
  'ublock-origin/filters.txt',
  'ublock-origin/quick-fixes.txt',
  'ublock-origin/resource-abuse.txt',
  'ublock-origin/unbreak.txt',
  'ublock-origin/privacy.txt'
]
const RESOURCES = 'ublock-origin/resources.json'

const dir = join(import.meta.dirname, '..', 'resources', 'filters')
// Download into a temporary directory next to it and swap it in only when every list succeeded,
// so a failed run leaves the current lists untouched.
const tmp = await mkdtemp(join(import.meta.dirname, '..', 'resources', '.filters-'))
try {
  const files = []
  for (const path of LISTS) {
    const res = await fetch(`${BASE}/${path}`)
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`)
    const file = path.replace('/', '--')
    await writeFile(join(tmp, file), await res.text())
    files.push(file)
    console.log(file)
  }
  const res = await fetch(`${BASE}/${RESOURCES}`)
  if (!res.ok) throw new Error(`${RESOURCES}: HTTP ${res.status}`)
  const resources = await res.text()
  JSON.parse(resources) // must be valid JSON
  await writeFile(join(tmp, 'resources.json'), resources)
  await writeFile(join(tmp, 'lists.json'), JSON.stringify(files, null, 2))
  await rm(dir, { recursive: true, force: true })
  await rename(tmp, dir)
  console.log(`resources.json + lists.json (${files.length} lists)`)
} catch (err) {
  await rm(tmp, { recursive: true, force: true })
  throw err
}
