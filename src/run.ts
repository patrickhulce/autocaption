import * as fs from 'fs'
import * as path from 'path'
import https from 'https'
import parseCsvFromStream from 'csv-parser'
import Bluebird from 'bluebird'
import {exec} from 'child_process'

// Whether to force overwrite existing captions.
const FORCE_ALL = false
// The path to a CSV in the format of "URL","CAPTION",*
const CSV_FILE_PATH = process.argv[2] || './examples/test.csv'
// The path to the CSV that will be written to.
const OUT_FILE = CSV_FILE_PATH.replace(/\.csv$/, '.out.csv')

type CsvRow =
  | ({failed: false; urlObject: URL} & OutputRow)
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
        if (!urlField || typeof urlField !== 'string') {
          results.push({failed: true, row: data})
          return
        }

        try {
          const urlObject = new URL(cleanUrl(urlField))
          // @ts-expect-error
          const otherProprties: OutputRow = Object.fromEntries(
            entries.map(({key, value}) => [key, value]),
          )

          results.push({
            failed: false,
            urlObject,
            ...otherProprties,
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

async function runPython<T>(pythonArgs: string[], outputParser: (stdout: string) => T): Promise<T> {
  return new Promise((resolve, reject) => {
    const pathToScript = path.resolve(__dirname, pythonArgs[0])
    exec(
      `python "${pathToScript}" ${pythonArgs
        .slice(1)
        .map(arg => JSON.stringify(arg))
        .join(' ')}`,
      (error, stdout, stderr) => {
        if (error) {
          console.error(
            `Execution error in python:\n\n${error.stack}\n\nSTDOUT:${stdout}\n\nSTDERR:${stderr}`,
          )
          reject(new Error(`Execution error in python: ${error.message}`))
        } else {
          try {
            resolve(outputParser(stdout))
          } catch (err) {
            reject(err)
          }
        }
      },
    )
  })
}

async function getCaption(url: string): Promise<string> {
  return runPython(['./caption.py', url], stdout => {
    try {
      const [{generated_text}] = JSON.parse(stdout)
      if (typeof generated_text == 'string') return generated_text
      else throw new Error(`Expected string, got ${JSON.stringify(generated_text)}`)
    } catch (err) {
      throw new Error(`Failed to parse JSON: ${stdout}`)
    }
  })
}

function concatenateStringValues(data: any): string {
  let result = ''

  if (typeof data === 'object' && data !== null) {
    for (let key in data) {
      result += concatenateStringValues(data[key])
    }
  } else if (typeof data === 'string') {
    result += data
  }

  return result
}

function isLikelyTextBased(caption: string): boolean {
  // This is almost always the icons.
  if (caption.includes('black and white') || caption.includes('white and black')) return false
  // Signs, posters, and collages all common captions for logos/banners.
  if (caption.match(/\b(sign|poster|collage)\b/)) return true
  // "Blurry image" usually means there's a big gradient background (sometimes text).
  if (caption.includes('a blurry image')) return true

  return false
}

async function getOcr(url: string, caption: string): Promise<string> {
  // If the caption doesn't contain any of the keywords, don't run the OCR.
  if (!isLikelyTextBased(caption)) return ''

  return runPython(['./ocr.py', url], stdout => {
    try {
      const detections = JSON.parse(stdout)
      return concatenateStringValues(detections)
    } catch (err) {
      throw new Error(`Failed to parse JSON: ${stdout}`)
    }
  })
}
async function getOcrQa(url: string, caption: string): Promise<string> {
  if (!isLikelyTextBased(caption)) return ''

  return runPython(['./ocr-qa.py', url], stdout => {
    try {
      const {question, answer} = JSON.parse(stdout)
      if (typeof answer !== 'string') throw new Error(`Expected string, got ${stdout}`)
      return answer
    } catch (err) {
      throw new Error(`Failed to parse JSON: ${stdout}`)
    }
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

type OutputRow = {
  url: string
  normalized_url: string
  caption: string
  ocr: string
  ocr_qa: string
  final: string
}

function write(results: Array<OutputRow>) {
  fs.writeFileSync(
    OUT_FILE,
    `URL,NORMALIZED_URL,CAPTION,OCR,OCR_QA,FINAL\n${results
      .map(row =>
        [row.url, row.normalized_url, row.caption, row.ocr, row.ocr_qa, row.final]
          .map(item => JSON.stringify(item.replace(/"/g, "'")))
          .join(','),
      )
      .join('\n')}`,
  )
}

function sanitizeUrlForFilename(url: string): string {
  return url
    .replace('https://', '')
    .replace(/[^a-z0-9]+/gi, '_')
    .toLowerCase()
}

function downloadFile(url: string, filePath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(filePath)
    let request = https.get(url, response => {
      response.pipe(file)
      file.on('finish', () => {
        file.close(() => resolve()) // close() is async, call resolve after close completes.
      })
    })

    // check if request was successful
    request.on('response', res => {
      if (res.statusCode !== 200) {
        reject(new Error(`Failed to get '${url}' (${res.statusCode})`))
      }
    })

    request.on('error', err => {
      // Handle errors
      fs.unlink(filePath, () => {}) // Delete the file async, ignore result.
      reject(err)
    })
  })
}

async function getFileForUrl(url: string): Promise<string> {
  const imageExtension = url.match(/\.(png|jpg|jpeg|gif|webp|svg)(\?|$|#)/i)?.[1] || 'jpg'
  const filename = `${sanitizeUrlForFilename(url)}.${imageExtension}`
  const dataDir = path.resolve(__dirname, '../data/images')
  fs.mkdirSync(dataDir, {recursive: true})
  const filePath = path.join(dataDir, filename)
  if (fs.existsSync(filePath)) return filePath

  console.log('Downloading', url, '...')
  await downloadFile(url, filePath)
  return filePath
}

function getFinal(data: {caption: string; ocr: string; ocr_qa: string}): string {
  return ''
}

export async function main() {
  const results: Array<OutputRow> = []
  const rows = await readRows()
  await Bluebird.map(
    rows,
    async (row, index) => {
      if (row.failed) {
        if (row.url) console.log('Failed to parse URL:', row.url, row.err)
        else console.log('Failed to parse row:', row.row)
      } else {
        if (row.final && !FORCE_ALL) {
          console.log('URL', row.urlObject.href, 'already has a finalized caption, skipping.')
          results.push(row as OutputRow)
          return
        }

        try {
          console.log(`Processing URL #${index}`, row.urlObject.href)
          const filePath = await getFileForUrl(row.urlObject.href)
          const caption = row.caption && !FORCE_ALL ? row.caption : await getCaption(filePath)
          console.log(`Got caption for #${index}:`, caption)
          const ocr = row.ocr && !FORCE_ALL ? row.ocr : await getOcr(filePath, caption)
          console.log(`Got OCR for #${index}:`, ocr)
          const ocr_qa = row.ocr_qa && !FORCE_ALL ? row.ocr_qa : await getOcrQa(filePath, caption)
          console.log(`Got OCR-QA for #${index}:`, ocr_qa)
          results.push({
            ...row,
            url: row.url || '',
            normalized_url: row.urlObject.href,
            caption,
            ocr,
            ocr_qa,
            final: getFinal({caption, ocr, ocr_qa}),
          })
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
