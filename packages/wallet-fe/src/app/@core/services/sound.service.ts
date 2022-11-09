import { Injectable } from "@angular/core";

const soundsObject = {
    TRADE_COMPLETED: "assets/sounds/fx1.mp3",
};

export enum ESounds {
    TRADE_COMPLETED = "TRADE_COMPLETED",
}

@Injectable ({
    providedIn: 'root',
})

export class SoundsService {
    constructor() {}

    playSound(sound: ESounds) {
        const url = soundsObject[sound];
        if (!url) return;
        const audio = new Audio(url);
        audio.load();
        audio.play();
    }
}
