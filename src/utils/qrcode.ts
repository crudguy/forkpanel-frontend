/**
 * 零依赖二维码编码器：byte 模式 + 纠错等级 M + 版本 1–10。
 *
 * 为什么自己写而不是装 `qrcode` / `qrcode-generator`：
 *  1. 面板的 dist 会被 rust-embed 内嵌进二进制、运行期零 Node，扫码能力属于
 *     「一次 enroll 才用一次」的冷路径，为它增加一个运行期依赖不划算；
 *  2. otpauth URI 只有 byte 模式一种输入形态，不需要多模式最优分段、ECI、
 *     Kanji、结构化追加这些通用库才有的分支；
 *  3. 二维码是纯本地计算——**绝不能**改调在线二维码服务，那等于把 TOTP 共享
 *     密钥发给第三方。
 *
 * 为什么纠错等级固定 M：otpauth 通行做法；L 在手机屏反光下容易扫不出，
 * Q/H 会让同样内容涨版本（模块变小反而更难扫）。
 */

export interface QrMatrix {
  /** 边长（模块数，不含静区） */
  size: number
  /** 实际使用的版本号 1–10 */
  version: number
  /** 实际使用的掩码 0–7（格式信息里如实编码，扫码器据此还原） */
  mask: number
  /** 行优先方阵：`modules[y][x] === true` 表示深色模块 */
  modules: boolean[][]
}

/** 纠错等级 M 的格式信息编码值（L=01 / M=00 / Q=11 / H=10）。 */
const ECC_M_FORMAT_BITS = 0b00

/** 各版本纠错等级 M 的数据码字数（ISO/IEC 18004 表 7）。 */
const DATA_CODEWORDS = [0, 16, 28, 44, 64, 86, 108, 124, 154, 182, 216] as const

/** 各版本纠错等级 M 的分块数与每块纠错码字数（表 9）。 */
const BLOCK_COUNT = [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5] as const
const ECC_PER_BLOCK = [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26] as const

/** 校正图形中心坐标；版本 1 没有校正图形。 */
const ALIGN_POS: readonly (readonly number[])[] = [
  [],
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
]

/** 数据位流填满码字后仍余下的填充位数（表 1 脚注）。 */
const REMAINDER_BITS = [0, 0, 7, 7, 7, 7, 7, 0, 0, 0, 0] as const

const MAX_VERSION = 10

// ─────────────── GF(256) 与 Reed–Solomon ───────────────

/** GF(256) 乘法，本原多项式 x^8+x^4+x^3+x^2+1（0x11d）。 */
function gfMul(a: number, b: number): number {
  let z = 0
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d)
    z ^= ((b >>> i) & 1) * a
  }
  return z & 0xff
}

/** 生成多项式 ∏(x-α^i)，i∈[0,degree)，返回去掉首项 1 之后的系数（降幂）。 */
function rsDivisor(degree: number): number[] {
  const result = new Array<number>(degree).fill(0)
  result[degree - 1] = 1
  let root = 1
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = gfMul(result[j], root)
      if (j + 1 < degree) result[j] ^= result[j + 1]
    }
    root = gfMul(root, 0x02)
  }
  return result
}

/** 计算一段数据的 RS 纠错码字。 */
function rsRemainder(data: readonly number[], divisor: readonly number[]): number[] {
  const result = divisor.map(() => 0)
  for (const b of data) {
    const factor = b ^ result.shift()!
    result.push(0)
    for (let i = 0; i < divisor.length; i++) result[i] ^= gfMul(divisor[i], factor)
  }
  return result
}

// ─────────────── 位流 ───────────────

/** 追加 `len` 位的 `value`（高位在前）。 */
function appendBits(bits: number[], value: number, len: number): void {
  for (let i = len - 1; i >= 0; i--) bits.push((value >>> i) & 1)
}

/** byte 模式的字符计数位数：版本 1–9 为 8 位，10–26 为 16 位。 */
function charCountBits(version: number): number {
  return version <= 9 ? 8 : 16
}

/** 选定版本：容纳 4 位模式指示 + 计数字段 + 8×字节数 的最小版本。 */
function pickVersion(byteLen: number): number {
  for (let v = 1; v <= MAX_VERSION; v++) {
    const capacityBits = DATA_CODEWORDS[v] * 8
    if (4 + charCountBits(v) + byteLen * 8 <= capacityBits) return v
  }
  throw new Error(`内容过长：${byteLen} 字节超出二维码版本 ${MAX_VERSION}（纠错等级 M）的容量`)
}

/** 编码成最终交织后的码字序列（数据码字在前、纠错码字在后）。 */
function buildCodewords(bytes: Uint8Array, version: number): number[] {
  const bits: number[] = []
  appendBits(bits, 0b0100, 4)
  appendBits(bits, bytes.length, charCountBits(version))
  for (const b of bytes) appendBits(bits, b, 8)

  const capacityBits = DATA_CODEWORDS[version] * 8
  // 结束符最多 4 位；随后补 0 对齐字节，再交替填充 0xEC / 0x11
  appendBits(bits, 0, Math.min(4, capacityBits - bits.length))
  appendBits(bits, 0, (8 - (bits.length % 8)) % 8)
  for (let pad = 0xec; bits.length < capacityBits; pad ^= 0xec ^ 0x11) appendBits(bits, pad, 8)

  const data: number[] = []
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j]
    data.push(byte)
  }

  // 分块：短块在前，长块（多 1 个数据码字）在后
  const blocks = BLOCK_COUNT[version]
  const eccLen = ECC_PER_BLOCK[version]
  const shortLen = Math.floor(data.length / blocks)
  const longCount = data.length % blocks
  const divisor = rsDivisor(eccLen)

  const dataBlocks: number[][] = []
  const eccBlocks: number[][] = []
  let offset = 0
  for (let i = 0; i < blocks; i++) {
    const len = shortLen + (i >= blocks - longCount ? 1 : 0)
    const blk = data.slice(offset, offset + len)
    offset += len
    dataBlocks.push(blk)
    eccBlocks.push(rsRemainder(blk, divisor))
  }

  // 交织：先按列取数据码字，再按列取纠错码字
  const out: number[] = []
  const maxData = shortLen + (longCount > 0 ? 1 : 0)
  for (let i = 0; i < maxData; i++) {
    for (const blk of dataBlocks) if (i < blk.length) out.push(blk[i])
  }
  for (let i = 0; i < eccLen; i++) {
    for (const blk of eccBlocks) out.push(blk[i])
  }
  return out
}

// ─────────────── 矩阵 ───────────────

function drawFinder(mods: boolean[][], func: boolean[][], cx: number, cy: number): void {
  const size = mods.length
  for (let dy = -4; dy <= 4; dy++) {
    for (let dx = -4; dx <= 4; dx++) {
      const x = cx + dx
      const y = cy + dy
      if (x < 0 || x >= size || y < 0 || y >= size) continue
      const dist = Math.max(Math.abs(dx), Math.abs(dy))
      mods[y][x] = dist !== 2 && dist !== 4
      func[y][x] = true
    }
  }
}

function drawAlignment(mods: boolean[][], func: boolean[][], cx: number, cy: number): void {
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      mods[cy + dy][cx + dx] = Math.max(Math.abs(dx), Math.abs(dy)) !== 1
      func[cy + dy][cx + dx] = true
    }
  }
}

/** 格式信息：2 位纠错等级 + 3 位掩码，BCH(15,5) 校验，再异或 0x5412。 */
export function formatInfoBits(mask: number): number {
  const data = (ECC_M_FORMAT_BITS << 3) | mask
  let rem = data
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537)
  return ((data << 10) | rem) ^ 0x5412
}

/** 版本信息：6 位版本号 + BCH(18,6) 校验（版本 ≥ 7 才存在）。 */
function versionInfoBits(version: number): number {
  let rem = version
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25)
  return (version << 12) | rem
}

function drawFormatBits(mods: boolean[][], mask: number): void {
  const size = mods.length
  const bits = formatInfoBits(mask)
  const bit = (i: number) => ((bits >>> i) & 1) !== 0
  const put = (x: number, y: number, dark: boolean) => {
    mods[y][x] = dark
  }

  for (let i = 0; i <= 5; i++) put(8, i, bit(i))
  put(8, 7, bit(6))
  put(8, 8, bit(7))
  put(7, 8, bit(8))
  for (let i = 9; i < 15; i++) put(14 - i, 8, bit(i))

  for (let i = 0; i < 8; i++) put(size - 1 - i, 8, bit(i))
  for (let i = 8; i < 15; i++) put(8, size - 15 + i, bit(i))
  // 固定深色模块（不承载信息，但必须存在）
  put(8, size - 8, true)
}

function maskHit(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0:
      return (x + y) % 2 === 0
    case 1:
      return y % 2 === 0
    case 2:
      return x % 3 === 0
    case 3:
      return (x + y) % 3 === 0
    case 4:
      return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0
    case 5:
      return ((x * y) % 2) + ((x * y) % 3) === 0
    case 6:
      return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0
    default:
      return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0
  }
}

/** 掩码惩罚分：四条规则之和，分越低越利于扫码。 */
function penalty(mods: boolean[][]): number {
  const size = mods.length
  let score = 0

  const runScore = (get: (i: number) => boolean) => {
    let run = 1
    const runs: number[] = []
    for (let i = 1; i < size; i++) {
      if (get(i) === get(i - 1)) run++
      else {
        runs.push(run)
        run = 1
      }
    }
    runs.push(run)
    for (const r of runs) if (r >= 5) score += 3 + (r - 5)
  }

  for (let y = 0; y < size; y++) runScore((x) => mods[y][x])
  for (let x = 0; x < size; x++) runScore((y) => mods[y][x])

  // 规则 2：2×2 同色块
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const c = mods[y][x]
      if (c === mods[y][x + 1] && c === mods[y + 1][x] && c === mods[y + 1][x + 1]) score += 3
    }
  }

  // 规则 3：1:1:3:1:1 且一侧有 4 个浅色模块（两个方向各算一次）
  const PATTERN_A = [true, false, true, true, true, false, true, false, false, false, false]
  const PATTERN_B = [false, false, false, false, true, false, true, true, true, false, true]
  const matches = (get: (i: number) => boolean, start: number, pat: boolean[]) => {
    for (let k = 0; k < 11; k++) if (get(start + k) !== pat[k]) return false
    return true
  }
  for (let y = 0; y < size; y++) {
    for (let x = 0; x + 11 <= size; x++) {
      const get = (i: number) => mods[y][i]
      if (matches(get, x, PATTERN_A)) score += 40
      if (matches(get, x, PATTERN_B)) score += 40
    }
  }
  for (let x = 0; x < size; x++) {
    for (let y = 0; y + 11 <= size; y++) {
      const get = (i: number) => mods[i][x]
      if (matches(get, y, PATTERN_A)) score += 40
      if (matches(get, y, PATTERN_B)) score += 40
    }
  }

  // 规则 4：深色占比每偏离 50% 满 5% 记 10 分
  let dark = 0
  for (const row of mods) for (const cell of row) if (cell) dark++
  const total = size * size
  score += Math.floor(Math.abs(dark * 20 - total * 10) / total) * 10

  return score
}

/**
 * 编码为二维码矩阵。内容超出容量时抛错（调用方退回纯文本展示）。
 *
 * `forceMask` 仅供测试钉住「编码正确」与「掩码择优」两件事：不传时按惩罚分
 * 选最优掩码；传 0–7 时强制该掩码，用来和参考实现逐模块对齐。
 */
export function qrMatrix(text: string, forceMask?: number): QrMatrix {
  const bytes = new TextEncoder().encode(text)
  const version = pickVersion(bytes.length)
  const size = version * 4 + 17
  const codewords = buildCodewords(bytes, version)

  const mods: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false))
  const func: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false))

  // 定位图样先占位：时序图样必须画在定位图样之前，由后者覆盖探出的部分
  for (let i = 0; i < size; i++) {
    mods[6][i] = i % 2 === 0
    func[6][i] = true
    mods[i][6] = i % 2 === 0
    func[i][6] = true
  }
  drawFinder(mods, func, 3, 3)
  drawFinder(mods, func, size - 4, 3)
  drawFinder(mods, func, 3, size - 4)

  const align = ALIGN_POS[version]
  for (let i = 0; i < align.length; i++) {
    for (let j = 0; j < align.length; j++) {
      const last = align.length - 1
      const overlapsFinder = (i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)
      if (!overlapsFinder) drawAlignment(mods, func, align[i], align[j])
    }
  }

  // 格式信息与版本信息占用的模块必须标记为功能区，否则数据会被写进去
  for (let i = 0; i <= 8; i++) {
    func[8][i] = true
    func[i][8] = true
  }
  for (let i = 0; i < 8; i++) func[8][size - 1 - i] = true
  // 列 8 的下半段含 7 个格式位 + 1 个固定深色模块，两者都必须算功能区：
  // 漏掉深色模块会让此后写入的数据位整体错位一格，矩阵看起来「几乎对」但扫不出。
  for (let i = 0; i < 8; i++) func[size - 1 - i][8] = true

  if (version >= 7) {
    for (let i = 0; i < 6; i++) {
      for (let j = 0; j < 3; j++) {
        func[i][size - 11 + j] = true
        func[size - 11 + j][i] = true
      }
    }
    const bits = versionInfoBits(version)
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >>> i) & 1) !== 0
      const a = size - 11 + (i % 3)
      const b = Math.floor(i / 3)
      mods[b][a] = dark
      mods[a][b] = dark
    }
  }

  // 数据位按「两列一组、自下而上/自上而下交替」的之字形写入
  const totalBits = codewords.length * 8 + REMAINDER_BITS[version]
  let bitIndex = 0
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5
    const upward = ((right + 1) & 2) === 0
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j
        const y = upward ? size - 1 - vert : vert
        if (func[y][x] || bitIndex >= totalBits) continue
        const byte = codewords[bitIndex >>> 3] ?? 0
        mods[y][x] = ((byte >>> (7 - (bitIndex & 7))) & 1) !== 0
        bitIndex++
      }
    }
  }

  // 八个掩码各算一次惩罚分，取最低者；并列时取小掩码号
  let bestMask = 0
  let bestScore = Number.POSITIVE_INFINITY
  let bestMatrix: boolean[][] | null = null
  for (let mask = 0; mask < 8; mask++) {
    if (forceMask !== undefined && mask !== forceMask) continue
    const trial = mods.map((row) => row.slice())
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (!func[y][x] && maskHit(mask, x, y)) trial[y][x] = !trial[y][x]
      }
    }
    drawFormatBits(trial, mask)
    const score = penalty(trial)
    if (score < bestScore) {
      bestScore = score
      bestMask = mask
      bestMatrix = trial
    }
  }

  return { size, version, mask: bestMask, modules: bestMatrix! }
}

/** 静区宽度（模块数）。ISO 18004 要求四周各留 4 个模块，少于它扫码器会认不出边界。 */
export const QR_QUIET_ZONE = 4

/**
 * 把矩阵转成一条 SVG path（单位=模块，含静区偏移）。
 *
 * 用单条 path 而不是 size² 个 `<rect>`：v10 有 3249 个模块，逐个元素在弱机上
 * 会明显拖慢首帧；`h1v1h-1z` 的连续小方块在 `shape-rendering="crispEdges"` 下
 * 与逐个矩形渲染完全等价。
 */
export function qrPath(matrix: QrMatrix, quiet = QR_QUIET_ZONE): string {
  const parts: string[] = []
  for (let y = 0; y < matrix.size; y++) {
    const row = matrix.modules[y]
    for (let x = 0; x < matrix.size; x++) {
      if (row[x]) parts.push(`M${x + quiet} ${y + quiet}h1v1h-1z`)
    }
  }
  return parts.join('')
}
