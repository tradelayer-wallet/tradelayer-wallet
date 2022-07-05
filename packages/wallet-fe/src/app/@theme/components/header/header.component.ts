import { Component, OnInit } from '@angular/core';
import { Router } from '@angular/router';
import { ToastrService } from 'ngx-toastr';
import { AuthService, IKeyPair } from 'src/app/@core/services/auth.service';
import { BalanceService } from 'src/app/@core/services/balance.service';
import { DialogService } from 'src/app/@core/services/dialogs.service';
import { MenuService } from 'src/app/@core/services/menu.service';
import { RpcService } from 'src/app/@core/services/rpc.service';
import { SocketService } from 'src/app/@core/services/socket.service';
import { WindowsService } from 'src/app/@core/services/windows.service';
// import { Themes, ThemesService } from 'src/app/@services/themes.services';

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
    },
    // {
    //   id: 2,
    //   name: 'Spot',
    //   link: 'spot',
    //   needAuthToShow: true,
    //   needFullSync: true,
    // },
    // {
    //   id: 3,
    //   name: 'Futures',
    //   link: 'futures',
    //   needAuthToShow: true,
    //   needFullSync: true,
    // },
    {
      id: 4,
      name: 'Portfolio',
      link: 'portfolio',
      needAuthToShow: true,
    },
    {
      id: 5,
      name: 'Settings',
      link: 'settings',
      needAuthToShow: true,
    },
    // {
    //   id: 6,
    //   name: 'Node Reward',
    //   link: 'reward',
    //   needAuthToShow: true,
    //   needFullSync: true,
    // },
    // {
    //   id: 7,
    //   name: 'Liquidity Provider',
    //   link: 'liquidity-provider',
    //   needAuthToShow: true,
    //   needFullSync: true,
    // },
    {
      id: 8,
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
    private balanceService: BalanceService,
    private toastrService: ToastrService,
    private rpcService: RpcService,
    private windowsService: WindowsService,
    private socketService: SocketService,
  ) { }

  get isApiRPC() {
    return this.rpcService.isApiRPC;
  }

  get mainRoutes(){
    return this._mainRoutes
      .filter(r => r.needAuthToShow ? this.isLoggedIn : true)
      .filter(r => r.needFullSync ? !this.isApiRPC : true);
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

  get allMainAddresses() {
    return this.isLoggedIn
      ? this.authService.walletKeys.main
      : null;
  }

  get publicAddress() {
    return this.isLoggedIn
      ? this.authService.activeMainKey.address
      : null;
  }

  get addressBalance() {
    return 0;
  }

  ngOnInit(): void {
      const tab = this.windowsService.tabs.find(e => e.title === 'Synchronization');
      if (tab) tab.minimized = true;
  }

  getAvailableBalance() {
    if (!this.publicAddress) return`${(0).toFixed(5)} LTC`;
    const balanceObj = this.balanceService.getFiatBalancesByAddress(this.publicAddress);
    return `${balanceObj.confirmed.toFixed(5)} LTC`;
  }

  copyToClipboard(text: string) {
    navigator.clipboard.writeText(text);
    this.toastrService.info('Address Copied to clipboard', 'Copied')
  }

  navigateTo(route: any) {
    if (route.id === 2 || route.id === 3) {
      if (!this.socketService.orderbookServerConnected) {
        this.toastrService.warning('Please first connect to orderbook Server');
        const window = this.windowsService.tabs.find(tab => tab.title === 'Orderbook Server');
        if (window) window.minimized = false;
        return;
      }
    }
    this.selectedRoute = route;
    this.router.navigateByUrl(route.link);
  }

  navigateToLoginRoute() {
    this.router.navigateByUrl('login');
    this.selectedRoute = null;
  }

  logOut() {
    this.authService.logout();
  }

  toggleSideBar() {
    // this.menuService.toggleSideBar();
  }

  updateBalance() {
      this.balanceService.updateBalances();
  }

  setMainAddress(kp: IKeyPair) {
    this.authService.activeMainKey = kp;
    this.balanceService.updateBalances();
  }
}
