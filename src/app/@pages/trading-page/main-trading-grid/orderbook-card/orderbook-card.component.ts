import { Component, OnInit } from '@angular/core';


export interface PeriodicElement {
  price: number;
  amount: number;
  total: number;
}

const ELEMENT_DATA_SELL: PeriodicElement[] = [
  {price: 999.99, amount: 999, total: 1},
  {price: 888.88, amount: 888, total: 1},
  {price: 777.77, amount: 777, total: 1},
  {price: 666.66, amount: 666, total: 1},
  {price: 555.55, amount: 555, total: 1},
  {price: 444.44, amount: 444, total: 1},
  {price: 333.33, amount: 333, total: 1},
  {price: 222.22, amount: 222, total: 1},
  {price: 111.11, amount: 111, total: 1},

];

const ELEMENT_DATA_BUY: PeriodicElement[] = [
  {price: 99.99, amount: 999, total: 724},
  {price: 88.88, amount: 888, total: 724},
  {price: 77.77, amount: 777, total: 724},
  {price: 66.66, amount: 666, total: 724},
  {price: 55.55, amount: 555, total: 724},
  {price: 44.44, amount: 444, total: 724},
  {price: 33.33, amount: 333, total: 724},
  {price: 22.22, amount: 222, total: 724},
  {price: 11.11, amount: 111, total: 724},
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
