const out = document.getElementById('out')!
const installed = document.getElementById('installed') as HTMLSelectElement
const plugins = (window.dosket as unknown as { plugins: { list(): Promise<string[]>; run(args: string[]): Promise<number>; restartSidecar(): void } }).plugins

async function refresh(): Promise<void> {
  installed.innerHTML = ''
  for (const name of await plugins.list()) {
    const option = document.createElement('option')
    option.value = name
    option.textContent = name
    installed.append(option)
  }
}

// pnpm 在同一 profile 目录上并发执行会互相破坏：运行期间禁用全部操作按钮。
function setBusy(busy: boolean): void {
  for (const id of ['add', 'remove', 'restart']) {
    ;(document.getElementById(id) as HTMLButtonElement).disabled = busy
  }
}

document.getElementById('add')!.addEventListener('click', async () => {
  const spec = (document.getElementById('spec') as HTMLInputElement).value.trim()
  if (spec === '') return
  setBusy(true)
  out.textContent += `$ dsh plugin --profile web add ${spec}\n`
  try {
    const code = await plugins.run(['add', spec])
    out.textContent += `（退出码 ${code}）\n`
    if (/allowBuilds|blocked/.test(out.textContent)) document.getElementById('allowbuilds')!.style.display = 'block'
    await refresh()
  } catch (error) {
    out.textContent += `run failed: ${error instanceof Error ? error.message : String(error)}\n`
  } finally {
    setBusy(false)
  }
})
document.getElementById('remove')!.addEventListener('click', async () => {
  const name = installed.value
  if (name === '') return
  setBusy(true)
  out.textContent += `$ dsh plugin --profile web remove ${name}\n`
  try {
    const code = await plugins.run(['remove', name])
    out.textContent += `（退出码 ${code}）\n`
    await refresh()
  } catch (error) {
    out.textContent += `run failed: ${error instanceof Error ? error.message : String(error)}\n`
  } finally {
    setBusy(false)
  }
})
document.getElementById('restart')!.addEventListener('click', () => plugins.restartSidecar())
window.addEventListener('dosket:plugins-output', (event) => { out.textContent += `${(event as CustomEvent<string>).detail}\n` })
void refresh()
