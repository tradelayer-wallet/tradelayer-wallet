import { Component } from '@angular/core';
import { Router } from '@angular/router';
import { ToastrService } from 'ngx-toastr';
import { AddressService } from 'src/app/@core/services/address.service';
import { AuthService } from 'src/app/@core/services/auth.service';
import { BalanceService } from 'src/app/@core/services/balance.service';
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
      needAuthToShow: false,
    },
    {
      id: 2,
      name: 'Spot',
      link: 'spot',
      needAuthToShow: true,
    },
    // {
    //   id: 3,
    //   name: 'Futures',
    //   link: 'futures',
    //   disabled: true,
    //   needAuthToShow: true,
    // },
    {
      id: 3,
      name: 'Portfolio',
      link: 'portfolio',
      needAuthToShow: true,
    },
    {
      id: 4,
      name: 'Settings',
      link: 'settings',
      needAuthToShow: true,
    },
    {
      id: 5,
      name: 'Node Reward',
      link: 'reward',
      needAuthToShow: true,
    },
    {
      id: 6,
      name: 'Multisig',
      link: 'multisig',
      needAuthToShow: false,
    },
  ];

  private _selectedRoute: any = this._mainRoutes[0];

  constructor(
    private router: Router,
    private menuService: MenuService,
    private authService: AuthService,
    private dialogService: DialogService,
    private addressService: AddressService,
    private balanceService: BalanceService,
    private toastrService: ToastrService,

  ) { }

  get mainRoutes(){
    return this._mainRoutes
      .filter(r => r.needAuthToShow ? this.isLoggedIn : true)
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

  get addressBalance() {
    return 
  }

  getAvailableBalance() {
    if (!this.publicAddress) return`${(0).toFixed(5)} LTC`;
    const balanceObj = this.balanceService.getFiatBalancesByAddress(this.publicAddress);
    const { confirmed, locked } = balanceObj;
    const available = confirmed - locked;
    return `${available.toFixed(5)} LTC`;
  }

  copyToClipboard(text: string) {
    navigator.clipboard.writeText(text);
    this.toastrService.info('Address Copied to clipboard', 'Copied')
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

  updateBalance() {
      this.balanceService.updateBalances();
  }

}
