const axios = require('axios');

// Configuration for the POST request
const config = {
    method: 'post',
    url: 'http://localhost:1986/tl/getChannel',
    headers: { 
        'Content-Type': 'application/json'
    },
    data: JSON.stringify({
        params: ["tltc1qn006lvcx89zjnhuzdmj0rjcwnfuqn7eycw40yf"] // Replace "your_address_here" with the actual address you want to test
    })
};

// Function to send the POST request
async function testGetChannel() {
    try {
        const response = await axios(config);
        console.log('Response:', response.data);
    } catch (error) {
        console.error('Error occurred:', error.response ? error.response.data : error.message);
    }
}

// Execute the function
testGetChannel();
