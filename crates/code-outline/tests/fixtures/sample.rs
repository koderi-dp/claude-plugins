/// A greeter.
pub struct Greeter {
    name: String,
}

impl Greeter {
    /// Builds a greeting.
    pub fn greet(&self) -> String {
        format!("hello {}", self.name)
    }
}

pub fn standalone() -> u32 {
    42
}
