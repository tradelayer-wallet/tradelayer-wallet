import { Component } from '@angular/core';

@Component({
  selector: 'tl-spot-history-card',
  templateUrl: './spot-history-card.component.html',
  styleUrls: ['./spot-history-card.component.scss']
})
export class SportHistoryCardComponent {
    displayedColumns: string[] = ['price', 'amount', 'total'];
    get orderHistory() {
        return new Array(20).fill(true)
            .map(e => {
                return {
                    price: Math.random() * 2,
                    amount: Math.random() * 20,
                }
            }).splice(0, 10);
    }
}
