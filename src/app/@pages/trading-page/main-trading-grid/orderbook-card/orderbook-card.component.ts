import { Component, OnInit } from '@angular/core';


export interface PeriodicElement {
  price: number;
  amount: number;
  total: number;
}

const ELEMENT_DATA_SELL: PeriodicElement[] = [
  {price: 362.45, amount: 2, total: 724},
  {price: 362.45, amount: 2, total: 724},
  {price: 362.65, amount: 2, total: 724},
  {price: 362.23, amount: 2, total: 724},
  {price: 362.16, amount: 2, total: 724},
  {price: 362.65, amount: 2, total: 724},
  {price: 362.23, amount: 2, total: 724},
  {price: 362.16, amount: 2, total: 724},
  {price: 362.16, amount: 2, total: 724},

];

const ELEMENT_DATA_BUY: PeriodicElement[] = [
  {price: 362.45, amount: 2, total: 724},
  {price: 362.45, amount: 2, total: 724},
  {price: 362.65, amount: 2, total: 724},
  {price: 362.23, amount: 2, total: 724},
  {price: 362.16, amount: 2, total: 724},
  {price: 362.65, amount: 2, total: 724},
  {price: 362.23, amount: 2, total: 724},
  {price: 362.16, amount: 2, total: 724},
  {price: 362.16, amount: 2, total: 724},
];

@Component({
  selector: 'tl-orderbook-card',
  templateUrl: './orderbook-card.component.html',
  styleUrls: ['./orderbook-card.component.scss']
})

export class OrderbookCardComponent implements OnInit {
    displayedColumns: string[] = ['price', 'amount', 'total'];
    dataSourceSell = ELEMENT_DATA_SELL;
    dataSourceBuy = ELEMENT_DATA_BUY;
    clickedRows = new Set<PeriodicElement>();
    upTrend: boolean = false;
    constructor() {}

    ngOnInit() {
      setInterval(() => this.upTrend = !this.upTrend, 2000)
    }

}
