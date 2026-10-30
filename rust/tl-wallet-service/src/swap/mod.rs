//! Channel swap protocol: trade description, open-order reservation, step state machine, payload
//! checks and the manager that ties them together.

pub mod checks;
pub mod machine;
pub mod manager;
pub mod order;
pub mod types;
