import * as fs from 'fs'
import * as path from 'path'
import https from 'https'
import parseCsvFromStream from 'csv-parser'
import Bluebird from 'bluebird'
import {exec} from 'child_process'
import {Configuration, OpenAIApi} from 'openai'
import sharp from 'sharp'

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
            width: Number(otherProprties.width),
            height: Number(otherProprties.height),
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

/**
 * Captions are trustworthy for actual photographs.
 * Captions are not trustworthy for logos, banners, or icons.
 * Problem is that it produces a photograph-like caption for these untrustworth items.
 */
function isCaptionLikelyTrustworthy(data: Partial<OutputRow>) {
  const {caption = '', width = 0, height = 0} = data

  // These are always logos.
  if (caption.match(/\b(sign|poster|collage|clock)\b/)) return false
  // These are almost always banners / graphic design elements.
  if (caption.match(/a blurry (image|photo)/)) return false
  // Square images are rarely photographs.
  if (width === height) return false
  // Mostly the Compass logos / icons
  const mentionsBlackAndWhite =
    caption.includes('black and white') || caption.includes('white and black')
  if (mentionsBlackAndWhite) return false

  // If the image is a standard photograph aspect ratio and discusses a person, a house, or furniture,
  // it's probably trustworthy.

  // Standard 4:3 ratio is 1.33 (landscape) 0.75 (portrait)
  const hasDimensions = Boolean(width && height)
  const isLandscape = hasDimensions && width / height > 1.2 && width / height < 1.4
  const isPortrait = hasDimensions && width / height > 0.7 && width / height < 0.8
  const isPhotographAspectRatio = isLandscape || isPortrait
  const mentionsPerson = caption.match(
    /\b(person|people|man|men|women|woman|child|boy|girl|family)\b/,
  )
  const mentionsHouse = caption.match(/\b(house|home|building|apartment)\b/)
  const mentionsFurniture = caption.match(
    /\b(table|chair|desk|couch|sofa|bed|lamp|light|window|door|kitchen|stairs|patio|living room|dining room)\b/,
  )

  return isPhotographAspectRatio && (mentionsPerson || mentionsHouse || mentionsFurniture)
}

function isLikelyTextBased(data: Partial<OutputRow>): boolean {
  const {caption = ''} = data
  if (isLikelyIcon(data)) return false
  // Signs, posters, and collages all common captions for logos/banners.
  if (caption.match(/\b(sign|poster|collage|clock)\b/)) return true
  // "Blurry image" usually means there's a big gradient background (sometimes text).
  if (caption.includes('a blurry image')) return true

  return false
}

function isLikelyIcon(data: Partial<OutputRow>): boolean {
  const {caption = '', width = 0, height = 0} = data
  const mentionsBlackAndWhite =
    caption.includes('black and white') || caption.includes('white and black')
  const isSquare = Boolean(width && height && width === height)
  return mentionsBlackAndWhite && isSquare
}

async function getOcr(url: string, data: Partial<OutputRow>): Promise<string> {
  if (isCaptionLikelyTrustworthy(data)) return ''

  return runPython(['./ocr.py', url], stdout => {
    try {
      const detections = JSON.parse(stdout)
      return concatenateStringValues(detections)
    } catch (err) {
      throw new Error(`Failed to parse JSON: ${stdout}`)
    }
  })
}
async function getOcrQa(url: string, data: Partial<OutputRow>): Promise<string> {
  if (isCaptionLikelyTrustworthy(data)) return ''
  if ((data.ocr?.length ?? 0) >= 10) return ''

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
    .replace(/["’”']+( .*)?$/g, '')
    .replace(/>([<\s].*)?$/g, '')
    .replace('[/img]', '')
    .replace('[/url]', '')
}

async function getImageDimensions(filePath: string): Promise<{width: number; height: number}> {
  const image = sharp(filePath)
  const metadata = await image.metadata()

  return {
    width: metadata.width || 0,
    height: metadata.height || 0,
  }
}

type OutputRow = {
  url: string
  normalized_url: string
  caption: string
  ocr: string
  ocr_qa: string
  heuristic: string
  gpt: string
  final: string
  width: number
  height: number
}

function write(results: Array<OutputRow>) {
  fs.writeFileSync(
    OUT_FILE,
    `URL,NORMALIZED_URL,WIDTH,HEIGHT,CAPTION,OCR,OCR_QA,HEURISTIC,GPT,FINAL\n${results
      .map(row =>
        [
          row.url,
          row.normalized_url,
          row.width.toString(),
          row.height.toString(),
          row.caption,
          row.ocr,
          row.ocr_qa,
          row.heuristic,
          row.gpt,
          row.final,
        ]
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
    .slice(0, 120)
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

type DataForFinal = Omit<OutputRow, 'final' | 'url' | 'normalized_url'>

async function getGpt(data: Omit<DataForFinal, 'gpt'>): Promise<string> {
  if (!process.env.OPENAI_API_KEY) return ''
  if (isCaptionLikelyTrustworthy(data)) return ''

  const configuration = new Configuration({
    apiKey: process.env.OPENAI_API_KEY,
  })
  const openai = new OpenAIApi(configuration)

  console.log('Asking OpenAI for final caption...')
  const dataToUse = isLikelyTextBased(data) ? {...data, caption: ''} : data
  const chatCompletion = await openai.createChatCompletion({
    model: 'gpt-3.5-turbo',
    messages: [
      {
        role: 'user',
        content: `
        You are determining the appropriate caption for an image using unreliable data.
        Your goal is to write a caption that is as accurate as possible to the underlying image given the following JSON data:

        "width" - The width of the image in pixels.
        "height" - The height of the image in pixels.
        "heuristic" - A simple estimate of the type of image that this is.
        "caption" - A faulty machine learning model that generates a caption based on the image.
           This model is frequently wrong and does not understand that many of these images are logos.
           It is particularly bad at reading text. Do not trust any statement that "the sign says X".
        "ocr" - A machine learning model that reads raw text from arbitrary images.
        "ocr_qa" - A machine learning model that reads raw text from the image.

        Reasoning to use:

        - If there is not enough data to make a decision, use the shortest possible description that you believe to be accurate.
        - If an image is small (under ~80 pixels in both dimensions) and similar to a square, or
         described as particular colors such as "black and white" or "white and blue", it is likely an icon.
        - If an image large (500px+) and much wider than it is tall, it is likely a banner with text.
        - If an image is described by the caption as a photograph of a particular scene, it is likely accurate.

        Output Format:

        Respond with just the string of the caption that describes the given image.
        Do not prefix it with "the image likely is" or "I think" or any other qualifiers.

        Examples:

        Input: {width: 60, height: 60, heuristic: "icon", caption: "A black and white image of a bird", ocr: "", ocr_qa: ""}
        Output: "The Twitter icon"

        Input: {width: 50, height: 50, heuristic: "icon", caption: "A black and white image of something", ocr: "", ocr_qa: ""}
        Output: "An icon"

        Input: {width: 400, height: 50, heuristic: "banner", caption: "", ocr: "", ocr_qa: ""}
        Output: "A text banner"

        Input: {width: 700, height: 100, heuristic: "banner", caption: "", ocr: "BESTD2021 WINNER", ocr_qa: "Compass"}
        Output: "A text banner describing Compass's awards"

        Input: {width: 200, height: 200, heuristic: "logo", caption: "", ocr: "CHRIS BEST REALTY", ocr_qa: "Christopher Best"}
        Output: "The logo of Christopher Best"

        Input: {width: 400, height: 300, heuristic: "photograph", caption: "A pool with a lounge chair and cabana", ocr: "", ocr_qa: ""}
        Output: "A pool with a lounge chair and cabana"

        Now output the caption corresponding to the data enclosed in """ below.

        """${JSON.stringify(dataToUse)}"""
      `,
      },
    ],
  })

  return chatCompletion.data.choices[0].message?.content || ''
}

async function getFinal(data: DataForFinal): Promise<string> {
  return data.gpt || data.caption
}

function getHeuristic(data: Partial<OutputRow>): string {
  const {width = 0, height = 0, caption = ''} = data

  const isSquare = width === height
  const maxDimension = Math.max(width, height)
  if (isSquare && maxDimension < 80) return 'icon'
  else if (isSquare) return 'logo'
  else if (width > 400 && width > height * 2) return 'banner'
  else if (caption.includes('photograph')) return 'photograph'
  else if (isCaptionLikelyTrustworthy(data)) return 'photograph'
  else if (caption.includes('a blurry')) return 'banner'
  else if (caption.match(/(sign|poster|collage|clock)/) && maxDimension > 400) return 'banner'
  else if (caption.match(/(sign|poster|collage|clock)/) && maxDimension <= 400) return 'logo'
  else return 'unknown'
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

          const {width, height} = await getImageDimensions(filePath)
          const outputRow: Partial<OutputRow> = {...row, width, height}
          console.log(`Got dimensions for #${index}: ${width}x${height}`)

          console.log(`Getting caption for #${index}`)
          const caption = row.caption && !FORCE_ALL ? row.caption : await getCaption(filePath)
          outputRow.caption = caption
          console.log(`Got caption for #${index}:`, caption)

          console.log(`Getting OCR for #${index}`)
          const ocr = row.ocr && !FORCE_ALL ? row.ocr : await getOcr(filePath, outputRow)
          outputRow.ocr = ocr
          console.log(`Got OCR for #${index}:`, ocr)

          console.log(`Getting OCR-QA for #${index}`)
          const ocr_qa = row.ocr_qa && !FORCE_ALL ? row.ocr_qa : await getOcrQa(filePath, outputRow)
          outputRow.ocr_qa = ocr_qa
          console.log(`Got OCR-QA for #${index}:`, ocr_qa)

          const heuristic = getHeuristic(outputRow)
          console.log(`Getting GPT for #${index}`)
          const gpt = await getGpt({width, height, caption, ocr, ocr_qa, heuristic})
          console.log(`Got GPT for #${index}`)

          const final = await getFinal({width, height, caption, ocr, ocr_qa, heuristic, gpt})
          console.log(`Got final for #${index}`)

          results.push({
            ...row,
            url: row.url || '',
            normalized_url: row.urlObject.href,
            caption,
            ocr,
            ocr_qa,
            heuristic,
            gpt,
            final,
            width,
            height,
          })

          write(results)
        } catch (err) {
          console.error(`Processing URL #${index} failed:`, err)
        }
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
