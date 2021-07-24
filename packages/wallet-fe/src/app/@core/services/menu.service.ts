import { Injectable } from "@angular/core";


@Injectable({
    providedIn: 'root',
})

export class MenuService {
    sideBar: any;

    constructor() {}

    toggleSideBar() {
        if (this.sideBar) this.sideBar.toggle();
    }
}
