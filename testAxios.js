const axios = require('axios');

async function fetchChannelData(address) {
    try {
        const response = await axios.post('http://localhost:3000/tl_getChannel', {
            params: address
        }, {
            headers: {
                'Content-Type': 'application/json'
            }
        });

        console.log('Channel Data:', response.data);
        return response.data;
    } catch (error) {
        console.error('Error fetching channel data:', error.message || error);
    }
}

// Example usage with an address
const address = 'tltc1qn006lvcx89zjnhuzdmj0rjcwnfuqn7eycw40yf';
fetchChannelData(address);
