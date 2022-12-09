import { Component, OnInit } from '@angular/core';
import { Router } from '@angular/router';
import { ToastrService } from 'ngx-toastr';
import { AuthService } from 'src/app/@core/services/auth.service';
import { BalanceService } from 'src/app/@core/services/balance.service';
import { ConnectionService } from 'src/app/@core/services/connections.service';
import { RpcService } from 'src/app/@core/services/rpc.service';
import { WindowsService } from 'src/app/@core/services/windows.service';

@Component({
  selector: 'tl-header',
  templateUrl: './header.component.html',
  styleUrls: ['./header.component.scss']
})

export class HeaderComponent implements OnInit {
  private _mainRoutes: {
    id: number;
    name: string;
    link: string;
    needAuthToShow: boolean;
    needFullSynced?: boolean;
  }[] = [
    {
      id: 1,
      name: 'Home',
      link: '/',
      needAuthToShow: false,
    },
    {
      id: 2,
      name: 'Portfolio',
      link: '/portfolio',
      needAuthToShow: true,
    },
    {
      id: 3,
      name: 'Spot Trading',
      link: '/spot',
      needAuthToShow: true,
    },
    {
      id: 4,
      name: 'Futures Trading',
      link: '/futures',
      needAuthToShow: true,
    },
    {
      id: 5,
      name: 'Node Reward',
      link: '/node-reward',
      needAuthToShow: true,
      needFullSynced: true,
    }
  ];

  private _selectedRoute: any = this._mainRoutes[0];
  public balanceLoading: boolean = false;
  constructor(
    private router: Router,
    private authService: AuthService,
    private balanceService: BalanceService,
    private connectionService: ConnectionService,
    private windowsService: WindowsService,
    private toastrService: ToastrService,
    private rpcService: RpcService,
  ) { }

  get selectedRoute(){
    return this._selectedRoute;
  }

  set selectedRoute(value: any){
    this._selectedRoute = value;
  }

  get mainRoutes(){
    return this._mainRoutes
      .filter(e => e.needAuthToShow ? this.isLoggedIn : true)
      .filter(e => e.needFullSynced ? this.isSynced : true);
  }

  get availableBalance() {
    return (this.balanceService.sumAvailableCoins).toFixed(6);
  }

  get isLoggedIn() {
    return this.authService.isLoggedIn;
  }

  get isSynced() {
    return this.rpcService.isSynced;
  }

  ngOnInit(): void { }

  navigateTo(route: any) {
    if (route.id === 3 || route.id === 4) {
      if (!this.connectionService.isOBSocketConnected) {
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
    this.router.navigateByUrl('login', { replaceUrl: true });
    this.selectedRoute = null;
  }

  logOut() {
    this.authService.logout();
  }

  toggleSideBar() {
    // this.menuService.toggleSideBar();
  }
  
  async updateBalance() {
    if (this.balanceLoading) return;
    this.balanceLoading = true;
    await this.balanceService.updateBalances();
    this.balanceLoading = false;
  }
}
