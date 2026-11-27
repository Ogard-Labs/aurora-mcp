#!/usr/bin/env node
/**
 * Drift check (#49): confirms that every AuroraCloud data shape this server
 * relies on (src/auroraContract.ts) is still defined the same way in a
 * read-only checkout of Ogard-Labs/auroradocs.
 *
 *   node --import tsx scripts/auroraDrift.mjs --auroradocs ../auroradocs
 *
 * Exits 0 when every entry matches, 1 when any entry drifted (each is named
 * with its auroradocs file), and 2 when the checkout cannot be read. It only
 * reads files; it never writes to either repository.
 */
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export function collapse(text) {
  return text.replace(/\s+/g, ' ').trim()
}

// A name character, Unicode names included (`café`, `ñ`), as JavaScript reads them.
const NAME = String.raw`[\p{ID_Continue}$\u200C\u200D]`
const WORD = new RegExp(NAME, 'u')

const NOT_NAME = String.raw`(?:^|(?!${NAME})[^])`
const REGEX_AFTER_WORD = new RegExp(String.raw`${NOT_NAME}(?:return|typeof|instanceof|in|of|new|delete|void|throw|case|do|else|yield|await)$`, 'u')
const CONTROL_BEFORE_PAREN = new RegExp(String.raw`${NOT_NAME}(?:if|while|for|with)\s*$`, 'u')
const NUMBER_DOT = new RegExp(String.raw`(?:^|(?!${NAME}|\.)[^])\d[\d_]*\.\s*$`, 'u')
const ENDS_WITH_NAME = new RegExp(`${NAME}$`, 'u')

/** Whether `text` ends with a keyword `pattern` matches, and not a member name such as `a.with` or `a?.return`. */
function endsWithKeyword(text, pattern) {
  const match = pattern.exec(text)
  if (!match) return false
  // The match starts with the keyword, or with the one character before it (which may be two code units).
  const start = match.index + (/^[A-Za-z]/.test(match[0]) ? 0 : String.fromCodePoint(match[0].codePointAt(0)).length)
  const head = text.slice(0, start)
  // A `.` ends a number like `1.` too; only a `.` after a name or a closing bracket is member access.
  return !/\.\s*$/.test(head) || NUMBER_DOT.test(head)
}

/**
 * `source` with every comment blanked out: each comment character becomes a
 * space, and line breaks stay, so line structure is kept. It is a small lexer:
 * quoted strings, template literals (with `${...}` nested to any depth) and
 * regular expression literals are read through, so a `//` or `/*` inside one
 * stays. The drift check matches against this, so a stale copy of a value in a
 * comment never stands in for the live code.
 */
export function stripComments(source) {
  let out = ''
  let index = 0
  // One entry per open `${`: the brace depth inside that interpolation.
  const interpolations = []
  // One entry per open `(`: whether it holds an `if`, `while`, `for` or `with`
  // condition, after which a `/` starts a regex rather than dividing.
  const parens = []
  let closedControl = false
  const blank = (text) => text.replace(/[^\r\n\u2028\u2029]/g, ' ')
  const take = (stop) => { out += source.slice(index, stop); index = stop }
  // Reads a template literal from just after its opening backtick, up to its
  // closing one or to the next `${`. Returns true when it stopped at `${`.
  const readTemplate = () => {
    let stop = index
    while (stop < source.length && source[stop] !== '`') {
      if (source[stop] === '\\') { stop += 2; continue }
      if (source[stop] === '$' && source[stop + 1] === '{') { take(stop + 2); interpolations.push(0); return }
      stop += 1
    }
    take(Math.min(stop + 1, source.length))
  }
  const regexMayStart = () => {
    const before = out.replace(/\s+$/, '')
    if (!before) return true
    if (ENDS_WITH_NAME.test(before)) return endsWithKeyword(before, REGEX_AFTER_WORD)
    if (before.endsWith(')')) return closedControl
    return /[(,=:[!&|?{};+\-*%<>~^]$/.test(before)
  }
  while (index < source.length) {
    const char = source[index]
    const next = source[index + 1]
    if (char === '/' && next === '/') {
      const end = source.slice(index).search(/[\r\n\u2028\u2029]/)
      const stop = end === -1 ? source.length : index + end
      out += blank(source.slice(index, stop))
      index = stop
    } else if (char === '/' && next === '*') {
      const end = source.indexOf('*/', index + 2)
      const stop = end === -1 ? source.length : end + 2
      out += blank(source.slice(index, stop))
      index = stop
    } else if (char === "'" || char === '"') {
      let stop = index + 1
      while (stop < source.length && source[stop] !== char && source[stop] !== '\n') stop += source[stop] === '\\' ? 2 : 1
      take(Math.min(stop + 1, source.length))
    } else if (char === '`') {
      take(index + 1)
      readTemplate()
    } else if (char === '{' && interpolations.length) {
      interpolations[interpolations.length - 1] += 1
      take(index + 1)
    } else if (char === '}' && interpolations.length) {
      take(index + 1)
      if (interpolations[interpolations.length - 1] === 0) {
        interpolations.pop()
        readTemplate()
      } else {
        interpolations[interpolations.length - 1] -= 1
      }
    } else if (char === '(') {
      parens.push(endsWithKeyword(out, CONTROL_BEFORE_PAREN))
      take(index + 1)
    } else if (char === ')') {
      closedControl = parens.pop() ?? false
      take(index + 1)
    } else if (char === '/' && regexMayStart()) {
      let stop = index + 1
      let inClass = false
      while (stop < source.length && source[stop] !== '\n') {
        if (source[stop] === '\\') { stop += 2; continue }
        if (source[stop] === '[') inClass = true
        else if (source[stop] === ']') inClass = false
        else if (source[stop] === '/' && !inClass) break
        stop += 1
      }
      take(Math.min(stop + 1, source.length))
    } else {
      take(index + 1)
    }
  }
  return out
}

/**
 * Whether `needle` appears in `text` as a whole: where it starts or ends with
 * a name or number character, the text beside it must not continue that name
 * or number. So `VERSION = 1` does not match `VERSION = 10`, and `'Done'` stays
 * exact because its quotes end it.
 */
export function containsWhole(text, needle) {
  if (!needle) return false
  for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + 1)) {
    // Whole code points, so a name character outside the BMP is read as one.
    const before = at > 0 ? [...text.slice(Math.max(0, at - 2), at)].pop() : ''
    const after = at + needle.length < text.length ? String.fromCodePoint(text.codePointAt(at + needle.length)) : ''
    if (WORD.test(needle[0]) && WORD.test(before)) continue
    if (WORD.test(needle[needle.length - 1]) && WORD.test(after)) continue
    return true
  }
  return false
}

/**
 * Whether `needle` appears in `raw` as a whole statement. After it, on the same
 * line, may come only block comments, then a `;`, a `}` or a line end (a line
 * comment may sit before that line end). A `;` or `}` ends the statement
 * whatever follows. At a line end, the next code (past blank lines and
 * comments) must not continue the expression. An entry sets `lineEnd` when its
 * source is a whole statement, so `VERSION = 1` does not match `VERSION = 1.1`,
 * `VERSION = 1 + 1`, or `VERSION = 1` with `+ 1` on the next line.
 *
 * Runs of whitespace in `needle` match any whitespace, except right after
 * `return`, `throw` or `yield`, where only same-line whitespace (a no-break
 * space too) may sit, since a line break would end the statement.
 */
export function endsLine(raw, needle) {
  const words = collapse(needle).split(' ').filter(Boolean)
  if (words.length < 1) return false
  const escape = (word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const body = words.map((word, index) => index === 0
    ? escape(word)
    : `${/^(?:return|throw|yield)$/.test(words[index - 1]) ? '[^\\S\\r\\n\\u2028\\u2029]+' : '\\s+'}${escape(word)}`).join('')
  const pattern = new RegExp(`${NOT_NAME}${body}`, 'gu')
  for (let match = pattern.exec(raw); match; match = pattern.exec(raw)) {
    const tail = /^(?:[ \t]|\/\*(?:[^*\n]|\*(?!\/))*\*\/)*(?:([;}])|(?:\/\/[^\n]*)?(?:\r?\n|$))/.exec(raw.slice(match.index + match[0].length))
    if (tail && (tail[1] || !continuesExpression(raw.slice(match.index + match[0].length + tail[0].length)))) return true
    // Step one whole code point, so a search never restarts inside a surrogate pair (which the `u` flag would read back to the same match).
    pattern.lastIndex = match.index + String.fromCodePoint(raw.codePointAt(match.index)).length
  }
  return false
}

/**
 * Whether code that starts `rest` (after blank lines and comments) would join
 * the expression before it. TypeScript's `as` and `satisfies` never join across
 * a line break, so a next line starting with them is a statement of its own.
 */
function continuesExpression(rest) {
  const code = rest.replace(/^(?:\s|\/\/[^\n]*|\/\*(?:[^*]|\*(?!\/))*\*\/)*/, '')
  return new RegExp(String.raw`^(?:[+\-*/%.?(\[\x60&|=<>^,:]|(?:in|instanceof)(?!${NAME}))`, 'u').test(code)
}

/** Checks each entry against the auroradocs checkout at `root`. Returns the drifted entries with a reason. */
export async function checkDrift(entries, root, read = (file) => readFile(file, 'utf8')) {
  const cache = new Map()
  const drifted = []
  for (const entry of entries) {
    const file = path.join(root, entry.file)
    if (!cache.has(file)) {
      // Comments are blanked first: only live code can match an entry.
      cache.set(file, read(file).then(stripComments).then((raw) => ({ raw, text: collapse(raw) }), (error) => ({ missing: error?.code ?? String(error) })))
    }
    const loaded = await cache.get(file)
    if ('missing' in loaded) {
      drifted.push({ entry, reason: `${entry.file} could not be read (${loaded.missing}); it may have moved` })
    } else if (!containsWhole(loaded.text, collapse(entry.source)) || (entry.lineEnd && !endsLine(loaded.raw, entry.source))) {
      drifted.push({ entry, reason: `${entry.file} no longer contains: ${collapse(entry.source)}` })
    }
  }
  return drifted
}

export function formatDrift(drifted) {
  return drifted.map(({ entry, reason }) =>
    `- ${entry.id} (${entry.what}, used by ${entry.usedBy.join(', ')}): ${reason}`).join('\n')
}

async function main(argv) {
  const index = argv.indexOf('--auroradocs')
  const root = index >= 0 ? argv[index + 1] : process.env.AURORADOCS_DIR
  if (!root) {
    console.error('Pass --auroradocs <path to an Ogard-Labs/auroradocs checkout>, or set AURORADOCS_DIR.')
    return 2
  }
  try {
    await readFile(path.join(root, 'package.json'), 'utf8')
  } catch {
    console.error(`${root} is not an auroradocs checkout (no package.json).`)
    return 2
  }
  const { AURORA_CONTRACT } = await import('../src/auroraContract.ts')
  const drifted = await checkDrift(AURORA_CONTRACT, root)
  if (drifted.length === 0) {
    console.log(`AuroraCloud contract: all ${AURORA_CONTRACT.length} entries match auroradocs.`)
    return 0
  }
  console.log(`AuroraCloud drift detected: ${drifted.length} of ${AURORA_CONTRACT.length} entries no longer match auroradocs.`)
  console.log(formatDrift(drifted))
  console.log('\nUpdate src/auroraContract.ts and the code that uses each entry, or fix auroradocs.')
  return 1
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = await main(process.argv.slice(2))
}
