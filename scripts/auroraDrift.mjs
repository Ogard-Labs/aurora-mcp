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
// Keywords after which a `{` opens an object literal (`else {` and `do {` open blocks).
const OBJECT_AFTER_WORD = new RegExp(String.raw`${NOT_NAME}(?:return|typeof|instanceof|in|of|new|delete|void|throw|case|yield|await)$`, 'u')
// The head of a function or class, up to its `(` or `{`.
const FUNCTION_HEAD = new RegExp(String.raw`${NOT_NAME}(?:async\s+)?function\s*(?:\*\s*)?(?:${NAME}+\s*)?$`, 'u')
const CLASS_HEAD = new RegExp(String.raw`${NOT_NAME}class(?:\s+(?!extends(?!${NAME}))${NAME}+)?(?:\s+extends\s+[^{};]+?)?$`, 'u')
// The built-in `String.raw` tag in any spelling: `String['raw']`,
// `globalThis.String.raw`, or wrapped in parentheses.
const RAW_REF = String.raw`(?:globalThis\s*\.\s*)?String\s*(?:\.\s*raw|\[\s*(?:'raw'|"raw")\s*\])`
const RAW_TAG = new RegExp(String.raw`(?:^|[^.\p{ID_Continue}$])(?:${RAW_REF}|\(\s*${RAW_REF}\s*\))$`, 'u')
// A switch label: the code since the last `;`, `{` or `}` starts with `case` or `default` and holds no `?`.
const SWITCH_LABEL = /^\s*(?:case(?![\p{ID_Continue}$])[^?]*|default\s*):\s*$/u
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
  return scanSource(source).code
}

// In `literal`: the backtick of a template tagged by a function other than `String.raw`.
const TAGGED = 2

/**
 * The lexer behind `stripComments`. Returns `code` (the source with comments
 * blanked, the same length as `source`) and `literal`, which marks with 1 each
 * position that is the text inside a string, template or regex literal, and
 * with 2 the backtick of a template tagged by a function other than `String.raw`. Quotes,
 * backticks and `${...}` interpolations are code. A drift match must start in
 * code, so an old declaration quoted in a string or template never stands in
 * for the live one.
 */
export function scanSource(source) {
  let out = ''
  const literal = new Uint8Array(source.length)
  const markLiteral = (start, stop) => literal.fill(1, start, Math.min(stop, source.length))
  let index = 0
  // One entry per open `${`: the brace depth inside that interpolation.
  const interpolations = []
  // One entry per open `(`: whether it holds an `if`, `while`, `for` or `with`
  // condition, after which a `/` starts a regex rather than dividing.
  const parens = []
  let closedControl = false
  // Whether the last `)` closed the parameters of a function expression.
  let closedFunctionExpression = false
  // One entry per open `{` (not `${`): whether it opens an object literal, an
  // operand, rather than a block. A `/` after the `}` of an object divides.
  const braces = []
  let closedObject = false
  // Where the last regex literal ended in `out`, so its closing `/` is not read as a division sign.
  let regexEnd = -1
  const blank = (text) => text.replace(/[^\r\n\u2028\u2029]/g, ' ')
  const take = (stop) => { out += source.slice(index, stop); index = stop }
  // Reads a template literal from just after its opening backtick, up to its
  // closing one or to the next `${`. Returns true when it stopped at `${`.
  const readTemplate = () => {
    let stop = index
    while (stop < source.length && source[stop] !== '`') {
      if (source[stop] === '\\') { stop += 2; continue }
      if (source[stop] === '$' && source[stop + 1] === '{') { markLiteral(index, stop); take(stop + 2); interpolations.push(0); return }
      stop += 1
    }
    markLiteral(index, stop)
    take(Math.min(stop + 1, source.length))
  }
  // Whether code after `text` is in operand position: after an operator, an
  // opening bracket, `,`, `:`, `=>` or a keyword such as `return`.
  const operandPosition = (text) => {
    const before = text.replace(/\s+$/, '')
    if (ENDS_WITH_NAME.test(before)) return endsWithKeyword(before, OBJECT_AFTER_WORD)
    return /[(,=:[!&|?+\-*%<>~^]$/.test(before)
  }
  // Whether `text` ends with the head of a function or class expression (the
  // keyword in operand position), whose `{...}` body then ends an operand.
  const expressionHead = (text, head) => {
    const match = head.exec(text)
    if (!match) return false
    const start = match.index + (/^[A-Za-z]/.test(match[0]) ? 0 : String.fromCodePoint(match[0].codePointAt(0)).length)
    const before = text.slice(0, start)
    // A `case x:` or `default:` label is followed by statements, so a function or class there is a declaration.
    if (/:\s*$/.test(before) && SWITCH_LABEL.test(before.slice(Math.max(before.lastIndexOf(';'), before.lastIndexOf('{'), before.lastIndexOf('}')) + 1))) return false
    return !/\.\s*$/.test(before) && operandPosition(before)
  }
  const opensObject = () => {
    const before = out.replace(/\s+$/, '')
    if (expressionHead(before, CLASS_HEAD)) return true
    if (before.endsWith(')')) return closedFunctionExpression
    if (before.endsWith('=>')) return false
    return operandPosition(before)
  }
  // Whether a template starting here is tagged by a function other than
  // `String.raw`. A tag gets the parts and can return any text, so a tagged
  // route may differ from its template; `String.raw` keeps the text.
  const taggedByOther = () => {
    // A TypeScript non-null `!` after the tag (`versioned!`) leaves it a tag; a `!` after an operator negates.
    const before = out.replace(/\s+$/, '').replace(/\s*!+$/, '').replace(/\s+$/, '')
    if (RAW_TAG.test(before)) return false
    if (ENDS_WITH_NAME.test(before)) return !endsWithKeyword(before, REGEX_AFTER_WORD)
    if (before.endsWith(')')) return !closedControl
    return before.endsWith(']')
  }
  const regexMayStart = () => {
    const before = out.replace(/\s+$/, '')
    if (!before) return true
    if (ENDS_WITH_NAME.test(before)) return endsWithKeyword(before, REGEX_AFTER_WORD)
    if (before.endsWith(')')) return closedControl
    // A postfix `++` or `--`, or TypeScript's non-null `!`, after an operand
    // (a name that is not a keyword, a `]`, or a `)` that closes no condition)
    // ends it, so a `/` after it divides. `return !/x/` still starts a regex.
    const postfix = /(?:\+\+|--|!+)$/.exec(before)
    if (postfix) {
      const operand = before.slice(0, postfix.index).replace(/\s+$/, '')
      const endsOperand = ENDS_WITH_NAME.test(operand)
        ? !endsWithKeyword(operand, REGEX_AFTER_WORD)
        : operand.endsWith(']') || (operand.endsWith(')') && !closedControl)
      if (endsOperand) return false
    }
    // A `/` that divides is an operator, so a regex may follow; the closing `/` of a regex is not one.
    if (before.endsWith('/')) return before.length !== regexEnd
    if (before.endsWith('}')) return !closedObject
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
      markLiteral(index + 1, stop)
      take(Math.min(stop + 1, source.length))
    } else if (char === '`') {
      if (taggedByOther()) literal[index] = TAGGED
      take(index + 1)
      readTemplate()
    } else if (char === '{') {
      braces.push(opensObject())
      if (interpolations.length) interpolations[interpolations.length - 1] += 1
      take(index + 1)
    } else if (char === '}' && interpolations.length) {
      take(index + 1)
      if (interpolations[interpolations.length - 1] === 0) {
        interpolations.pop()
        readTemplate()
      } else {
        interpolations[interpolations.length - 1] -= 1
        closedObject = braces.pop() ?? false
      }
    } else if (char === '}') {
      closedObject = braces.pop() ?? false
      take(index + 1)
    } else if (char === '(') {
      parens.push({ control: endsWithKeyword(out, CONTROL_BEFORE_PAREN), functionExpression: expressionHead(out.replace(/\s+$/, ''), FUNCTION_HEAD) })
      take(index + 1)
    } else if (char === ')') {
      const closed = parens.pop()
      closedControl = closed?.control ?? false
      closedFunctionExpression = closed?.functionExpression ?? false
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
      markLiteral(index + 1, stop)
      take(Math.min(stop + 1, source.length))
      regexEnd = out.length
    } else {
      take(index + 1)
    }
  }
  return { code: out, literal }
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
export function endsLine(raw, needle, literal) {
  return findInCode(raw, needle, literal, true)
}

/**
 * Whether `needle` (runs of whitespace matching any whitespace) appears in
 * `raw` starting in code, where `literal` marks string, template and regex
 * text. With `statement`, the match must also end the statement (see
 * `endsLine`); without, it must only not run on into a longer name.
 */
export function findInCode(raw, needle, literal, statement = false) {
  const words = collapse(needle).split(' ').filter(Boolean)
  if (words.length < 1) return false
  const escape = (word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const body = words.map((word, index) => index === 0
    ? escape(word)
    : `${/^(?:return|throw|yield)$/.test(words[index - 1]) ? '[^\\S\\r\\n\\u2028\\u2029]+' : '\\s+'}${escape(word)}`).join('')
  const end = new RegExp(NAME, 'u').test(words[words.length - 1].slice(-1)) ? `(?!${NAME})` : ''
  // A name boundary on the left only when the needle starts with a name: a template may follow a tag (`String.raw`).
  const pattern = new RegExp(`${WORD.test(words[0][0]) ? NOT_NAME : ''}(${body})${end}`, 'gu')
  let last = -1
  for (let match = pattern.exec(raw); match; match = pattern.exec(raw)) {
    // Each step must move forward; a regression here must fail, not hang the check.
    if (match.index <= last) throw new Error('drift check stopped advancing')
    last = match.index
    const start = match.index + match[0].length - match[1].length
    const inCode = (!literal || literal[start] === 0) && literalsExact(raw, start, match[1].length, needle, literal)
    // An entry that is one whole string or template is an operand: the code after it must not go on with
    // the value (`'/route' + '/v2'` is another route).
    const operandKept = !wholeLiteral(needle) || operandKeptAt(raw, start, match.index + match[0].length)
    if (inCode && operandKept && !statement) return true
    const tail = /^(?:[ \t]|\/\*(?:[^*\n]|\*(?!\/))*\*\/)*(?:([;}])|(?:\/\/[^\n]*)?(?:\r?\n|$))/.exec(raw.slice(match.index + match[0].length))
    if (statement && inCode && operandKept && tail && (tail[1] || !continuesExpression(raw.slice(match.index + match[0].length + tail[0].length)))) return true
    // Step one whole code point, so a search never restarts inside a surrogate pair (which the `u` flag would read back to the same match).
    pattern.lastIndex = match.index + String.fromCodePoint(raw.codePointAt(match.index)).length
  }
  return false
}

/**
 * Whether the match of `needle` at `start` (of `length`) keeps every
 * whitespace character inside a literal exactly. Whitespace in code may differ
 * in kind and amount, but `'In  Progress'` is not `'In Progress'`.
 */
function literalsExact(raw, start, length, needle, literal) {
  if (!literal) return true
  const space = /\s/
  let j = 0
  for (let i = start; i < start + length;) {
    if (literal[i] === 1 && space.test(raw[i])) {
      if (needle[j] !== raw[i]) return false
      i += 1
      j += 1
    } else if (space.test(raw[i])) {
      while (i < start + length && literal[i] !== 1 && space.test(raw[i])) i += 1
      while (j < needle.length && space.test(needle[j])) j += 1
    } else {
      i += 1
      j += 1
    }
  }
  return true
}

/** Whether `needle` is one string or template literal and nothing else. */
function wholeLiteral(needle) {
  const quote = needle[0]
  if (!`'"\``.includes(quote) || needle.length < 2 || needle[needle.length - 1] !== quote) return false
  for (let i = 1; i < needle.length - 1; i += 1) {
    if (needle[i] === '\\') i += 1
    else if (needle[i] === quote) return false
  }
  return true
}

/**
 * Whether the whole literal at `start`..`end` of `raw` is used as one value:
 * nothing joins an operator to it on either side. TypeScript assertions
 * (`<T>x`, `x!`, `x as T`, `x satisfies T`) and grouping parentheses keep the
 * value, so the check looks through them; call parentheses (`f(x)`) end it.
 */
function operandKeptAt(raw, start, end) {
  let left = skipLeftAssertions(raw.slice(0, start))
  let right = skipRightAssertions(raw.slice(end))
  while (right !== null && left.endsWith('(') && right.startsWith(')') && groupsParen(left.slice(0, -1))) {
    left = skipLeftAssertions(left.slice(0, -1))
    right = skipRightAssertions(right.slice(1))
  }
  // An assertion whose type cannot be read fails closed: the route may go on past it.
  return right !== null && !joinsOperandBefore(left) && !continuesOperand(right)
}

/** Whether a `(` after `before` groups an expression rather than calling something. */
function groupsParen(before) {
  const code = before.replace(/\s+$/, '')
  if (ENDS_WITH_NAME.test(code)) return endsWithKeyword(code, REGEX_AFTER_WORD)
  return !/[)\]]$/.test(code)
}

/** `before` without trailing whitespace and angle-bracket assertions such as `<const>` or `<A.B>`. */
function skipLeftAssertions(before) {
  const cast = new RegExp(String.raw`(^|[^\p{ID_Continue}$)\]\s])(\s*)<\s*${NAME}+(?:\s*\.\s*${NAME}+)*\s*>\s*$`, 'u')
  let code = before.replace(/\s+$/, '')
  for (let next = code.replace(cast, '$1$2').replace(/\s+$/, ''); next !== code; next = code.replace(cast, '$1$2').replace(/\s+$/, '')) code = next
  return code
}

const skipSpace = (text) => text.replace(/^(?:\s|\/\/[^\n]*|\/\*(?:[^*]|\*(?!\/))*\*\/)*/, '')

/** `rest` without leading whitespace, comments, non-null `!` (not `!=`), and `as T` or `satisfies T` assertions, or null when a type cannot be read. */
function skipRightAssertions(rest) {
  let code = skipSpace(rest)
  for (;;) {
    if (/^!(?!=)/.test(code)) { code = skipSpace(code.slice(1)); continue }
    const keyword = new RegExp(String.raw`^(?:as|satisfies)(?!${NAME})\s*`, 'u').exec(code)
    if (!keyword) return code
    const after = skipType(code.slice(keyword[0].length))
    if (after === null) return null
    code = skipSpace(after)
  }
}

/** The index just past the bracket that closes the one at `text[0]`, or -1. Quotes are read through. */
function closeBracket(text) {
  const pairs = { '(': ')', '[': ']', '{': '}', '<': '>' }
  const stack = []
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]
    if (char === "'" || char === '"' || char === '`') {
      for (i += 1; i < text.length && text[i] !== char; i += text[i] === '\\' ? 2 : 1);
    } else if (pairs[char] && (char !== '<' || stack.length === 0 || stack[stack.length - 1] === '>')) {
      stack.push(pairs[char])
    } else if (char === '>' && text[i - 1] === '=') {
      // The arrow of a function type inside generics, not a closer.
    } else if (char === stack[stack.length - 1]) {
      stack.pop()
      if (stack.length === 0) return i + 1
    }
  }
  return -1
}

/** `text` after one TypeScript type at its start (names, literals, generics, indexed access, unions), or null. */
function skipType(text) {
  let code = text
  for (;;) {
    code = code.replace(/^\s*(?:(?:keyof|typeof|readonly|unique)\s+)*/, '')
    const simple = new RegExp(String.raw`^(?:'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|\x60(?:[^\x60\\$]|\\.|\$(?!\{)|\$\{[^{}\x60]*\})*\x60|-?\d[\d_.]*|${NAME}+(?:\s*\.\s*${NAME}+)*)`, 'u').exec(code)
    if (simple) code = code.slice(simple[0].length)
    else if (/^[([{]/.test(code)) {
      const close = closeBracket(code)
      if (close < 0) return null
      code = code.slice(close)
    } else return null
    // Generic arguments and indexed access or array suffixes.
    for (let suffix = /^\s*[<[]/.exec(code); suffix; suffix = /^\s*[<[]/.exec(code)) {
      const close = closeBracket(code.slice(suffix[0].length - 1))
      if (close < 0) return null
      code = code.slice(suffix[0].length - 1 + close)
    }
    // Conditional and function types are not read; fail closed so drift is never hidden.
    if (new RegExp(String.raw`^\s*(?:(?:extends|is|infer)(?!${NAME})|=>)`, 'u').test(code)) return null
    const union = /^\s*(?:\|(?!\|)|&(?!&))/.exec(code)
    if (!union) return code
    code = code.slice(union[0].length)
  }
}

/** Whether code that ends `before` (comments are already blanked, assertions skipped) joins an operator to the operand after it. `=>` does not. */
function joinsOperandBefore(before) {
  const code = before.replace(/\s+$/, '')
  if (code.endsWith('=>')) return false
  return /[+\-*/%&|^<>?]$/.test(code) || new RegExp(String.raw`(?:^|(?!${NAME})[^])(?:in|instanceof)$`, 'u').test(code)
}

/** Whether code that starts `rest` (assertions already skipped) goes on with the operand before it. */
function continuesOperand(rest) {
  const code = skipSpace(rest)
  // A `(` or a backtick after a string would call it, which no route does.
  return new RegExp(String.raw`^(?:[+\-*/%.?\[&|=<>^!]|(?:in|instanceof)(?!${NAME}))`, 'u').test(code)
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
      cache.set(file, read(file).then(scanSource).then(({ code, literal }) => ({ raw: code, literal, text: collapse(code) }), (error) => ({ missing: error?.code ?? String(error) })))
    }
    const loaded = await cache.get(file)
    if ('missing' in loaded) {
      drifted.push({ entry, reason: `${entry.file} could not be read (${loaded.missing}); it may have moved` })
    } else if (!containsWhole(loaded.text, collapse(entry.source)) || !findInCode(loaded.raw, entry.source, loaded.literal, entry.lineEnd)) {
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
