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
    width: 1280,
    height: 800,
    webPreferences: {
      nodeIntegration: true
    }
  })
  // Open the DevTools.
  mainWindow.webContents.openDevTools();

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

// app.on('browser-window-focus', function () {
//   globalShortcut.register("CommandOrControl+R", () => {
//       console.log("CommandOrControl+R is pressed: Shortcut Disabled");
//   });
//   globalShortcut.register("F5", () => {
//       console.log("F5 is pressed: Shortcut Disabled");
//   });
// });

// app.on('browser-window-blur', function () {
//   globalShortcut.unregister('CommandOrControl+R');
//   globalShortcut.unregister('F5');
// });

try {
  require('electron-reloader')(module, {
    watchRenderer: true,    
  })

} catch (_) {
  console.log('fail')
}