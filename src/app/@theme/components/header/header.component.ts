import { Component } from '@angular/core';
import { Router } from '@angular/router';
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

  navigateTo(route: any) {
    this.selectedRoute = route;
    this.router.navigateByUrl(route.link);
  }

  navigateToLoginRoute() {
    this.router.navigateByUrl('login');
    this.selectedRoute = null;
  }

  toggleSideBar() {
    this.menuService.toggleSideBar();
  }
}
