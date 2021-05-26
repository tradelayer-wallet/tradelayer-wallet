const { app, BrowserWindow, globalShortcut } = require('electron')
const url = require("url");
const path = require("path");

let mainWindow

const loadUrl = (w) => {
  w.loadURL(
    url.format({
      pathname: path.join(__dirname, `/dist/index.html`),
      protocol: "file:",
      slashes: true
    })
  );
}

function createWindow () {
  mainWindow = new BrowserWindow({
    width: 1027,
    height: 768,
    webPreferences: {
      nodeIntegration: true
    }
  })
  // Open the DevTools.
  mainWindow.webContents.openDevTools()

  loadUrl(mainWindow);

  mainWindow.webContents.on('did-fail-load', () => {
    loadUrl(mainWindow);
  })

  mainWindow.on('closed', function () {
    mainWindow = null
  })
}

app.on('ready', createWindow)

app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', function () {
  console.log('activate')
  if (mainWindow === null) createWindow()
})

try {
  require('electron-reloader')(module, {
    watchRenderer: true,    
  })

} catch (_) {
  console.log('fail')
}