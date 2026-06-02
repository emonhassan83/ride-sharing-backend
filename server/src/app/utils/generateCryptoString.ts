export const generateCryptoString = (length: number): string => {
  length += 1
  const chars = '0123456789'
  const array = new Uint8Array(length - 1)
  crypto.getRandomValues(array)

  return 'SR-' + Array.from(array, (byte) => chars[byte % chars.length]).join('')
}