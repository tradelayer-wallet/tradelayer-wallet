#!/bin/bash
# Auto builder builds only for OS same as the os from where the script is ran
# compatible tested version: node v16.10.0, npm v7.24.0
# The script could take around 2-3 minutes

#Ask the user about the OS

#If throw an error uncomment next line and try again
#export NODE_OPTIONS=--openssl-legacy-provider

echo Please select OS you are using [w: Windows, l: Linux, m: MAC ]
read osvar
if [[ $osvar != "w" && $osvar != "l" && $osvar != "m" ]]; then
    echo 'wrong OS choice'
    echo Press Any key for exit
    read exit
    exit 0
fi
#command npm run install:all includes 2 commands:
#npm install #install all dependencies from main directory
#npm install --prefix ./packages/wallet-fe #install all dependencies for angular front-end directory
npm run install:all

#npm run build:all:__OS__ command includes 3 commands: 
#npm run fe:build #build angular front-end
#npm run build:all:__OS__ #one of the cases below
#npm run electron:build #build the main electron file

case $osvar in

  w)
    echo Building for Windows
    #npm run server:build:windows #build the server with windows node and windows configs
    npm run build:all:windows
    ;;

  l)
    echo Building for Linux
    #npm run server:build:linux #build the server with linux node and linux configs
    npm run build:all:linux
    ;;

  m)
    echo Building for Mac
    #npm run server:build:mac #build the server with mac node and mac configs
    npm run build:all:mac
    ;;
esac

#command electron:dist package the final executable and its ready for updloading new release
npm run electron:dist

echo Press Any key for exit
read exit