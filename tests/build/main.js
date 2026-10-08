document.querySelector('#load').addEventListener('click', async () => {
  const { load } = await import('./lazy.js')
  document.querySelector('#result').textContent = await load()
})
