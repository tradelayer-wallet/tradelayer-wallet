import { Component } from '@angular/core';
import { MatIconRegistry } from '@angular/material/icon';
import { DomSanitizer } from '@angular/platform-browser';

@Component({
  selector: 'tl-layout',
  templateUrl: './layout.component.html',
  styleUrls: ['./layout.component.scss']
})

export class LayoutComponent {
  private iconsArray = [
    {
      name: 'settings',
      filename: 'settings.svg',
    },
    {
      name: 'resize',
      filename: 'resize.svg',
    },
    {
      name: 'close',
      filename: 'close.svg',
    }
  ];

  constructor(
    private matIconRegistry: MatIconRegistry,
    private domSanitizer: DomSanitizer,
  ) {
    this.addIcons();
  }

  private addIcons() {
    this.iconsArray.forEach(({ name, filename }) => this._addIcon(name, filename));
  }

  private _addIcon(name: string, filename: string) {
    const url = this.domSanitizer.bypassSecurityTrustResourceUrl(`assets/icons/${filename}`);
    this.matIconRegistry.addSvgIcon(name, url)
  }
}
