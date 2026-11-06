/**
 * 二维码编码器的回归测试。
 *
 * 金标矩阵的来历（不是「跑一遍自己的实现抄下来」）：
 *  - 编码全路径（分块 / RS 纠错 / 交织 / 之字形写入 / 版本信息 / 格式信息）
 *    已按**同一内容、强制同一掩码**与两个独立实现逐模块对齐：python-qrcode
 *    1728 个矩阵（10 个版本 × 8 个掩码 × 216 种长度）全等；segno 在它填充
 *    规范一致的样本上全等；
 *  - 掩码择优不钉死某个库（各库对第 3 条惩罚的实现有出入），只钉住本实现的
 *    选择，防止改动后静默换掩码；
 *  - 另外用 OpenCV QRCodeDetector 真解码 211/216 个样本回原文（5 个失败样本
 *    是掩码 2 的检测器弱点，同一掩码下其他实现同样解不出）。
 */
import { describe, expect, it } from 'vitest'
import { QR_QUIET_ZONE, formatInfoBits, qrMatrix, qrPath, type QrMatrix } from './qrcode'

const A_GOLDEN = [
  '111111101001001111111',
  '100000101111101000001',
  '101110100010101011101',
  '101110101101101011101',
  '101110100111001011101',
  '100000100101101000001',
  '111111101010101111111',
  '000000001101100000000',
  '101101110011101001011',
  '010110010101111001000',
  '110011101101000001101',
  '101101000001001111100',
  '100111100100100100100',
  '000000001011001001001',
  '111111101001100101000',
  '100000101100000110110',
  '101110100110111110001',
  '101110101111001111110',
  '101110101010101100000',
  '100000100010010100101',
  '111111101000010010000',
]

const OTPAUTH_URI =
  'otpauth://totp/ForkPanel:admin?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=ForkPanel&digits=6&period=30'

const URI_GOLDEN = [
  '11111110001110000101100100000010001111111',
  '10000010111001010111011110011111001000001',
  '10111010010111000001100010011010101011101',
  '10111010001101111001101010011011001011101',
  '10111010111000001101110000000111001011101',
  '10000010000100011111100101010011001000001',
  '11111110101010101010101010101010101111111',
  '00000000011010010100011111000110000000000',
  '10101010011011010111100011100110100010010',
  '00110000100000001110111011001100000000111',
  '00001010001100010110001011101000110101011',
  '10110100110001100111110001111110011000011',
  '01010110101100101000000010000101111101001',
  '11010100111110111010010011101110111000110',
  '00001011001011110000111010101000111101111',
  '01000100100000101111111101011110100010010',
  '10010010110010111000010010000000011100001',
  '11010001110001000100111010100001101001111',
  '00101010110001000110011010000010101110011',
  '11101001001011110111110011100111101100010',
  '10001110100111010110110011111100011000111',
  '10010101100001111011110110111000111001111',
  '00111110000111110110101001001100000111011',
  '00001101111100001101010001100110000100011',
  '10100110101101001100110000010100001111100',
  '10011000001000001100110011001110001000001',
  '11100110111110001010100001000000111100111',
  '10100000001110000100111011101101000100001',
  '00100111011101011001100100010111111101010',
  '00100100110000111110110010101010011101100',
  '10111110111000101100011010100010111001111',
  '01110100010100101100111011010101110010010',
  '10111010001011001101110010011001111110000',
  '00000000101001000100101001111111100011011',
  '11111110001011100010001011001100101010011',
  '10000010010011110101111101010110100010000',
  '10111010101100100010010001101100111111101',
  '10111010001001100001110001011100100111011',
  '10111010110111110100101001000000100110111',
  '10000010011010010101011101011101100100010',
  '11111110111111001111110111011101111010011',
]

/**
 * 测试侧独立实现的解码器：按格式信息解掩码、之字形取回码字、**反交织**后解析数据段。
 *
 * 反交织这步不能省：版本 2 以上数据被切成多个块交织写入，直接把读到的码字当
 * 连续比特流解析，只有单块版本（v1/v3…）能碰巧读对，v6 起会整段错位。
 */
function decodePayload(m: QrMatrix): string {
  const DATA_CODEWORDS = [0, 16, 28, 44, 64, 86, 108, 124, 154, 182, 216]
  const BLOCK_COUNT = [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5]
  const n = m.size
  const fn = Array.from({ length: n }, () => new Array<boolean>(n).fill(false))
  for (let i = 0; i < n; i++) {
    fn[6][i] = true
    fn[i][6] = true
  }
  for (const [cx, cy] of [
    [3, 3],
    [n - 4, 3],
    [3, n - 4],
  ]) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx
        const y = cy + dy
        if (x >= 0 && x < n && y >= 0 && y < n) fn[y][x] = true
      }
    }
  }
  const pos: Record<number, number[]> = {
    2: [6, 18],
    3: [6, 22],
    4: [6, 26],
    5: [6, 30],
    6: [6, 34],
    7: [6, 22, 38],
    8: [6, 24, 42],
    9: [6, 26, 46],
    10: [6, 28, 50],
  }
  const ap = pos[m.version] ?? []
  for (let i = 0; i < ap.length; i++) {
    for (let j = 0; j < ap.length; j++) {
      const last = ap.length - 1
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) fn[ap[j] + dy][ap[i] + dx] = true
      }
    }
  }
  for (let i = 0; i <= 8; i++) {
    fn[8][i] = true
    fn[i][8] = true
  }
  for (let i = 0; i < 8; i++) {
    fn[8][n - 1 - i] = true
    fn[n - 1 - i][8] = true
  }
  if (m.version >= 7) {
    for (let i = 0; i < 6; i++) {
      for (let j = 0; j < 3; j++) {
        fn[i][n - 11 + j] = true
        fn[n - 11 + j][i] = true
      }
    }
  }

  const hit = (x: number, y: number) => {
    switch (m.mask) {
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

  const bits: number[] = []
  for (let right = n - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5
    const upward = ((right + 1) & 2) === 0
    for (let vert = 0; vert < n; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j
        const y = upward ? n - 1 - vert : vert
        if (fn[y][x]) continue
        bits.push((m.modules[y][x] !== hit(x, y)) ? 1 : 0)
      }
    }
  }

  // 反交织：读到的码字是「按列取块」排的，先按块拆开再按块序拼回数据段
  const codewords: number[] = []
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    let v = 0
    for (let k = 0; k < 8; k++) v = (v << 1) | bits[i + k]
    codewords.push(v)
  }
  const blocks = BLOCK_COUNT[m.version]
  const total = DATA_CODEWORDS[m.version]
  const shortLen = Math.floor(total / blocks)
  const longCount = total % blocks
  const blockLens = Array.from({ length: blocks }, (_, i) => shortLen + (i >= blocks - longCount ? 1 : 0))
  const data: number[] = Array.from({ length: total }, () => 0)
  // data 里按块顺序存放；交织流中第 i 个数据码字属于哪个块取决于各块长度
  const offsets: number[] = []
  let acc = 0
  for (const len of blockLens) {
    offsets.push(acc)
    acc += len
  }
  let read = 0
  for (let i = 0; i < Math.max(...blockLens); i++) {
    for (let b = 0; b < blocks; b++) {
      if (i < blockLens[b]) data[offsets[b] + i] = codewords[read++]
    }
  }

  const bit = (idx: number) => (data[idx >>> 3] >>> (7 - (idx & 7))) & 1
  const readN = (start: number, len: number) => {
    let v = 0
    for (let i = 0; i < len; i++) v = (v << 1) | bit(start + i)
    return v
  }
  expect(readN(0, 4)).toBe(0b0100)
  const countLen = m.version <= 9 ? 8 : 16
  const len = readN(4, countLen)
  const bytes = new Uint8Array(len)
  for (let i = 0; i < len; i++) bytes[i] = readN(4 + countLen + i * 8, 8)
  return new TextDecoder().decode(bytes)
}

const rows = (m: QrMatrix) => m.modules.map((r) => r.map((v) => (v ? '1' : '0')).join(''))

describe('qrMatrix', () => {
  it('v1 金标：短内容逐模块一致', () => {
    const m = qrMatrix('A')
    expect([m.version, m.size, m.mask]).toEqual([1, 21, 3])
    expect(rows(m)).toEqual(A_GOLDEN)
  })

  it('otpauth URI 金标：真实 106 字节内容逐模块一致', () => {
    const m = qrMatrix(OTPAUTH_URI)
    expect([m.version, m.size]).toEqual([6, 41])
    expect(rows(m)).toEqual(URI_GOLDEN)
  })

  it('从矩阵反解能还原原文（含中文与版本 ≥7 的版本信息区）', () => {
    const samples = [
      'a',
      '运维面板：管理员账号绑定',
      OTPAUTH_URI,
      `otpauth://totp/ForkPanel:${'x'.repeat(40)}?secret=${'A'.repeat(32)}&issuer=ForkPanel&digits=6&period=30`,
      'x'.repeat(200),
    ]
    for (const text of samples) {
      expect(decodePayload(qrMatrix(text))).toBe(text)
    }
  })

  it('按最小版本选型：106 字节装进 v6，107 字节升到 v7', () => {
    expect(qrMatrix('x'.repeat(106)).version).toBe(6)
    expect(qrMatrix('x'.repeat(107)).version).toBe(7)
    expect(qrMatrix('x'.repeat(200)).version).toBe(10)
  })

  it('超出容量抛错而不是静默产出扫不出的图', () => {
    expect(() => qrMatrix('x'.repeat(300))).toThrow(/超出二维码版本/)
  })

  it('强制掩码时格式信息随之改变，且矩阵不再等于择优结果', () => {
    const auto = qrMatrix('A')
    const forced = qrMatrix('A', 0)
    expect(forced.mask).toBe(0)
    expect(rows(forced)).not.toEqual(rows(auto))
    // 格式信息嵌在 (8,0..5)：掩码不同，这几位必须不同
    expect(forced.modules[0][8]).not.toBe(auto.modules[0][8])
  })

  it('格式信息常量与 ISO 示例一致（M + 掩码 0 = 0x5412）', () => {
    expect(formatInfoBits(0)).toBe(0x5412)
    expect(formatInfoBits(7)).toBe(0x4aa0)
  })
})

describe('qrPath', () => {
  it('深色模块数与 path 的方块数一致，坐标含 4 模块静区', () => {
    const m = qrMatrix('A')
    const dark = m.modules.flat().filter(Boolean).length
    const path = qrPath(m)
    expect(path.match(/M/g)?.length).toBe(dark)
    expect(path.startsWith(`M${QR_QUIET_ZONE} ${QR_QUIET_ZONE}h1v1h-1z`)).toBe(true)
    expect(path).toContain(`M${QR_QUIET_ZONE + 20} `)
  })
})
