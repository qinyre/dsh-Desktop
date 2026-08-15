// Electron 内置 Node 必须满足 dsh 的 engines 约束 ^22.19 || >=24（设计书 §2/§10）。
const [major, minor] = process.versions.node.split('.').map(Number)
const ok = (major === 22 && minor >= 19) || major >= 24
console.log(`electron node ${process.versions.node} ${ok ? 'ok' : 'BELOW 22.19 — bump electron major'}`)
process.exit(ok ? 0 : 1)
