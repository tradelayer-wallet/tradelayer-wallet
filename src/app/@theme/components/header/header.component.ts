import { Component } from '@angular/core';
import { Router } from '@angular/router';
import { AddressService } from 'src/app/@core/services/address.service';
import { AuthService } from 'src/app/@core/services/auth.service';
import { DialogService } from 'src/app/@core/services/dialogs.service';
import { MenuService } from 'src/app/@core/services/menu.service';
// import { Themes, ThemesService } from 'src/app/@services/themes.services';

@Component({
  selector: 'tl-header',
  templateUrl: './header.component.html',
  styleUrls: ['./header.component.scss']
})

export class HeaderComponent {
  private _mainRoutes: any[] = [
    {
      id: 1,
      name: 'Home',
      link: '/',
    },
    {
      id: 2,
      name: 'Trading',
      link: 'trading',
    },
    {
      id: 3,
      name: 'Portfolio',
      link: '#',
      disabled: true,
    },
    {
      id: 4,
      name: 'Taxes',
      link: '#',
      disabled: true,
    }
  ];

  private _selectedRoute: any = this._mainRoutes[0];

  constructor(
    private router: Router,
    private menuService: MenuService,
    private authService: AuthService,
    private dialogService: DialogService,
    private addressService: AddressService,
  ) { }

  get mainRoutes(){
    return this._mainRoutes;
  }

  get selectedRoute(){
    return this._selectedRoute;
  }

  set selectedRoute(value: any){
    this._selectedRoute = value;
  }

  get isLoggedIn() {
    return this.authService.isLoggedIn;
  }


  get publicAddress() {
    return this.isLoggedIn
      ? this.addressService.activeKeyPair?.address
      : null;
  }

  navigateTo(route: any) {
    this.selectedRoute = route;
    this.router.navigateByUrl(route.link);
  }

  navigateToLoginRoute() {
    this.router.navigateByUrl('login');
    this.selectedRoute = null;
  }

  logOut() {
    const encKey = this.authService.encKey;
    this.dialogService.openEncKeyDialog(encKey);
    this.authService.logout();
  }

  toggleSideBar() {
    this.menuService.toggleSideBar();
  }
}
