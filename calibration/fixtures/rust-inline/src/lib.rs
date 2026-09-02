mod service;

pub use service::value;

#[cfg(test)]
mod tests {
    #[test]
    fn crate_is_exercised() {
        assert_eq!(super::value(), 1);
    }
}
