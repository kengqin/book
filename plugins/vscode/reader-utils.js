function lineStartFromProgress(lineCount, progress, visibleLineCount = 5) {
  const maximumStart = Math.max(0, Number(lineCount) - visibleLineCount)
  const normalized = Math.max(0, Math.min(100, Number(progress) || 0))
  return Math.max(0, Math.min(maximumStart, Math.round(maximumStart * normalized / 100)))
}

module.exports = { lineStartFromProgress }
