import { Component, OnInit } from '@angular/core';
import { Router } from '@angular/router';
import { ToastrService } from 'ngx-toastr';

@Component({
  selector: 'tl-header',
  templateUrl: './header.component.html',
  styleUrls: ['./header.component.scss']
})

export class HeaderComponent implements OnInit {
  private _mainRoutes: any[] = [
    {
      id: 1,
      name: 'Home',
      link: '/',
      needAuthToShow: false,
    }
  ];

  private _selectedRoute: any = this._mainRoutes[0];

  constructor(
    private router: Router,
    private toastrService: ToastrService,
  ) { }

  get selectedRoute(){
    return this._selectedRoute;
  }

  set selectedRoute(value: any){
    this._selectedRoute = value;
  }

  get mainRoutes(){
    return this._mainRoutes;
  }

  ngOnInit(): void {
      // const tab = this.windowsService.tabs.find(e => e.title === 'Synchronization');
      // if (tab) tab.minimized = true;
  }

  copyToClipboard(text: string) {
    navigator.clipboard.writeText(text);
    this.toastrService.info('Address Copied to clipboard', 'Copied')
  }

  navigateTo(route: any) {
    // if (route.id === 2 || route.id === 3) {
    //   if (!this.socketService.orderbookServerConnected) {
    //     this.toastrService.warning('Please first connect to orderbook Server');
    //     const window = this.windowsService.tabs.find(tab => tab.title === 'Orderbook Server');
    //     if (window) window.minimized = false;
    //     return;
    //   }
    // }
    this.selectedRoute = route;
    this.router.navigateByUrl(route.link);
  }

  navigateToLoginRoute() {
    // this.router.navigateByUrl('login');
    // this.selectedRoute = null;
  }

  logOut() {
    // this.authService.logout();
  }

  toggleSideBar() {
    // this.menuService.toggleSideBar();
  }
}
