import { describe, expect, it } from 'vitest'
import { isLightBackground, parseCssColor, toColorRef } from './titlebar-color'

describe('parseCssColor', () => {
  it('parses rgb() and rgba() forms', () => {
    expect(parseCssColor('rgb(12, 30, 48)')).toEqual([12, 30, 48])
    expect(parseCssColor('rgba(255, 255, 255, 1)')).toEqual([255, 255, 255])
    expect(parseCssColor('rgb(1 2 3)')).toEqual([1, 2, 3])
  })
  it('rejects non-color text and out-of-range channels', () => {
    expect(parseCssColor('')).toBeNull()
    expect(parseCssColor('#0c1e30')).toBeNull()
    expect(parseCssColor('none')).toBeNull()
    expect(parseCssColor('rgb(300, 0, 0)')).toBeNull()
  })
})

describe('toColorRef', () => {
  it('lays out COLORREF as 0x00BBGGRR', () => {
    expect(toColorRef([12, 30, 48])).toBe(0x00301e0c)
    expect(toColorRef([255, 0, 0])).toBe(0x000000ff)
    expect(toColorRef([0, 255, 0])).toBe(0x0000ff00)
    expect(toColorRef([0, 0, 255])).toBe(0x00ff0000)
  })
})

describe('isLightBackground', () => {
  it('classifies by relative luminance', () => {
    expect(isLightBackground([255, 255, 255])).toBe(true)
    expect(isLightBackground([240, 242, 245])).toBe(true)
    expect(isLightBackground([12, 30, 48])).toBe(false)
    expect(isLightBackground([23, 25, 30])).toBe(false)
  })
})
