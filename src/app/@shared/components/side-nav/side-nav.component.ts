import { AfterViewInit, Component, EventEmitter, OnInit, Output, ViewChild } from '@angular/core';
import { DialogService, DialogTypes } from 'src/app/@core/services/dialogs.service';
import { MenuService } from 'src/app/@core/services/menu.service';

@Component({
  selector: 'tl-side-nav',
  templateUrl: './side-nav.component.html',
  styleUrls: ['./side-nav.component.scss']
})
export class SideNavComponent implements AfterViewInit {
  @ViewChild('sideNav') sideNav: any;


  constructor(
    private menuService: MenuService,
    private dialogService: DialogService,
  ) { }

  ngAfterViewInit() {
    this.menuService.sideBar = this.sideNav;
  }

  openLink() {
    this.dialogService.openDialog(DialogTypes.COMMING_SOON);
  }
}
