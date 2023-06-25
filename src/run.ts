import * as fs from 'fs'
import parseCsvFromStream from 'csv-parser'
import Bluebird from 'bluebird'

// Whether to force overwrite existing captions.
const FORCE = false
// The path to a CSV in the format of "URL","CAPTION",*
const CSV_FILE_PATH = './examples/test.csv'
// The path to the CSV that will be written to.
const OUT_FILE = './examples/test.out.csv'

type CsvRow =
  | {failed: false; url: URL; caption?: string}
  | {failed: true; row: Record<string, unknown>; url?: string}

function readRows(): Promise<Array<CsvRow>> {
  let results: Array<CsvRow> = []
  return new Promise((resolve, reject) =>
    fs
      .createReadStream(CSV_FILE_PATH)
      .pipe(parseCsvFromStream())
      .on('data', data => {
        const entries = Object.entries(data).map(([key, value]) => ({
          key: key.toLowerCase(),
          value,
        }))
        const urlField = entries.find(({key}) => key === 'url')?.value
        const captionField = entries.find(({key}) => key === 'caption')?.value
        if (!urlField || typeof urlField !== 'string' || !urlField.startsWith('http')) {
          results.push({failed: true, row: data})
          return
        }

        const url = new URL(urlField)
        if (url.href !== urlField) {
          results.push({failed: true, row: data, url: urlField})
          return
        }

        results.push({
          failed: false,
          url,
          caption: typeof captionField === 'string' ? captionField : undefined,
        })
      })
      .on('error', reject)
      .on('end', () => {
        resolve(results)
      }),
  )
}

async function getCaption(url: string): Promise<string> {
  return `caption for ${url}`
}

export async function main() {
  const results: Array<[string, string]> = []
  const rows = await readRows()
  await Bluebird.map(
    rows,
    async row => {
      if (row.failed) {
        if (row.url) console.log('Failed to parse URL:', row.url)
        else console.log('Failed to parse row:', row.row)
      } else {
        if (row.caption && !FORCE) {
          console.log('URL', row.url.pathname, 'already has a caption, skipping.', row)
          results.push([row.url.href, row.caption])
          return
        }

        console.log('Processing URL', row.url, '...')
        const caption = await getCaption(row.url.href)
        console.log(`Got caption for ${row.url.pathname}:`, caption)
        results.push([row.url.href, caption])
      }
    },
    {concurrency: 10},
  )

  fs.writeFileSync(
    OUT_FILE,
    `URL,CAPTION\n${results
      .map(([url, caption]) => `"${url.replace(/"/g, "'")}","${caption.replace(/"/g, "'")}"`)
      .join('\n')}`,
  )
}

main().catch(err => {
  console.error(err.stack)
  process.exit(1)
})
