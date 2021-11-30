import { Injectable } from "@angular/core";


@Injectable({
    providedIn: 'root',
})

export class RewardService {
    private _rewardAddresses: any[] = [];
    private _maxNRewardAddresses: number = 5;

    constructor() {}

    get rewardAddresses() {
        return this._rewardAddresses;
    }

    set rewardAddresses(value: any[]) {
        this._rewardAddresses = value;
    }

    get maxNRewardAddresses() {
        return this._maxNRewardAddresses;
    }

    addNewRewardAddress() {
        if (this._rewardAddresses.length >= this._maxNRewardAddresses) return;
        const newRewardAddress = {};
        this.rewardAddresses = [...this.rewardAddresses, newRewardAddress];
    }
}
