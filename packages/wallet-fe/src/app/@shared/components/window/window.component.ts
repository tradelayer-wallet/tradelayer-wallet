import { Component, Input } from '@angular/core';
import { ToastrService } from 'ngx-toastr';
import { WindowsService } from 'src/app/@core/services/windows.service';

@Component({
  selector: 'custom-window',
  templateUrl: './window.component.html',
  styleUrls: ['./window.component.scss']
})
export class WindowComponent {
  @Input('title') title = 'Untitled Window';
    constructor (
      private windowsService: WindowsService,
      private toastrService: ToastrService,
  ) { }

  get isMinimized() {
    const tab = this.windowsService.tabs.find(t => t.title === this.title);
    return tab ? tab.minimized : true;
  }

  minimize() {
    const title = this.title;
    const tab = this.windowsService.tabs.find(t => t.title === title);
    if (tab) tab.minimized = true;
  }

  close() {
    this.toastrService.error( 'This Window can not be closed!', 'Error')
  }
}
