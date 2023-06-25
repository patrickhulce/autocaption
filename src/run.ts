import * as fs from 'fs'
import * as path from 'path'
import parseCsvFromStream from 'csv-parser'
import Bluebird from 'bluebird'
import {exec} from 'child_process'

// Whether to force overwrite existing captions.
const FORCE = false
// The path to a CSV in the format of "URL","CAPTION",*
const CSV_FILE_PATH = process.argv[2] || './examples/test.csv'
// The path to the CSV that will be written to.
const OUT_FILE = CSV_FILE_PATH.replace(/\.csv$/, '.out.csv')

type CsvRow =
  | {failed: false; url: URL; caption?: string}
  | {failed: true; row: Record<string, unknown>; url?: string; err?: unknown}

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
        if (!urlField || typeof urlField !== 'string') {
          results.push({failed: true, row: data})
          return
        }

        try {
          const url = new URL(cleanUrl(urlField))

          results.push({
            failed: false,
            url,
            caption: typeof captionField === 'string' ? captionField : undefined,
          })
        } catch (err) {
          results.push({failed: true, row: data, url: urlField, err})
        }
      })
      .on('error', reject)
      .on('end', () => {
        resolve(results)
      }),
  )
}

async function getCaption(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const pathToScript = path.resolve(__dirname, 'caption.py')
    exec(`python "${pathToScript}" ${JSON.stringify(url)}`, (error, stdout, stderr) => {
      if (error) {
        console.error(
          `Execution error in python:\n\n${error.stack}\n\nSTDOUT:${stdout}\n\nSTDERR:${stderr}`,
        )
        reject(new Error(`Execution error in python: ${error.message}`))
        return
      }

      try {
        const [{generated_text}] = JSON.parse(stdout)
        if (typeof generated_text == 'string') resolve(generated_text)
        else reject(new Error(`Expected string, got ${JSON.stringify(generated_text)}`))
      } catch (err) {
        reject(new Error(`Failed to parse JSON: ${stdout}`))
      }
    })
  })
}

function cleanUrl(url: string): string {
  if (url.startsWith('//')) url = `https:${url}`
  return url
    .trim()
    .replace(/["’]+( .*)?$/g, '')
    .replace(/>([<\s].*)?$/g, '')
    .replace('[/img]', '')
    .replace('[/url]', '')
}

function write(results: Array<[string, string]>) {
  fs.writeFileSync(
    OUT_FILE,
    `URL,CAPTION\n${results
      .map(([url, caption]) => `"${url.replace(/"/g, "'")}","${caption.replace(/"/g, "'")}"`)
      .join('\n')}`,
  )
}

export async function main() {
  const results: Array<[string, string]> = []
  const rows = await readRows()
  await Bluebird.map(
    rows,
    async (row, index) => {
      if (row.failed) {
        if (row.url) console.log('Failed to parse URL:', row.url, row.err)
        else console.log('Failed to parse row:', row.row)
      } else {
        if (row.caption && !FORCE) {
          console.log('URL', row.url.pathname, 'already has a caption, skipping.')
          results.push([row.url.href, row.caption])
          return
        }

        try {
          console.log(`Processing URL #${index}`, row.url.href)
          const caption = await getCaption(row.url.href)
          console.log(`Got caption for #${index}:`, caption)
          results.push([row.url.href, caption])
        } catch (err) {
          console.error(`Processing URL #${index} failed:`, err)
        }

        write(results)
      }
    },
    {concurrency: 5},
  )

  write(results)
}

main().catch(err => {
  console.error(err.stack)
  process.exit(1)
})
