import { Component, OnInit } from '@angular/core';
import { Router } from '@angular/router';
import { ToastrService } from 'ngx-toastr';
import { AuthService } from 'src/app/@core/services/auth.service';

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
    private authService: AuthService,
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
    return 0;
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

  }
}
