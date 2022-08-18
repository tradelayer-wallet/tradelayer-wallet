import { Component, OnInit } from '@angular/core';
import { Router } from '@angular/router';
import { ToastrService } from 'ngx-toastr';
import { AuthService } from 'src/app/@core/services/auth.service';
import { BalanceService } from 'src/app/@core/services/balance.service';

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
    {
      id: 2,
      name: 'Portfolio',
      link: '/portfolio',
      needAuthToShow: true,
    }
  ];

  private _selectedRoute: any = this._mainRoutes[0];

  constructor(
    private router: Router,
    private authService: AuthService,
    private balanceService: BalanceService,
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

  get availableBalance() {
    return (this.balanceService.sumAvailableCoins).toFixed(6);
  }

  get isLoggedIn() {
    return this.authService.isLoggedIn;
  }

  ngOnInit(): void { }

  navigateTo(route: any) {
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
  
  updateBalance() {
    this.balanceService.updateBalances();
  }
}
